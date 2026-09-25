const API_BASE = `${location.origin}/api`;

let token = localStorage.getItem('elara_dashboard_token') || '';

function setToken(t) {
  token = t;
  localStorage.setItem('elara_dashboard_token', t);
}

// Navigation
document.querySelectorAll('.menu a').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    document.querySelectorAll('.menu a').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    link.classList.add('active');
    document.getElementById('view-' + link.dataset.view).classList.add('active');
  });
});

// Settings Save
document.getElementById('save-settings').addEventListener('click', () => {
  const val = document.getElementById('settings-token').value;
  setToken(val);
  alert('Token saved');
});
document.getElementById('settings-token').value = token;

// Fetch helpers
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

let approvalRefreshRunning = false;
async function loadApprovals() {
  if (!token || approvalRefreshRunning) return;
  approvalRefreshRunning = true;
  const panel = document.getElementById('pending-approvals');
  const items = document.getElementById('approval-items');
  try {
    const { approvals } = await apiGet('/approvals');
    items.replaceChildren();
    panel.hidden = approvals.length === 0;
    for (const approval of approvals) {
      const entry = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = `${approval.toolName} on ${approval.targetDeviceId}`;
      const details = document.createElement('pre');
      details.textContent = `Session: ${approval.sessionId}\nExpires: ${new Date(approval.expiresAt).toLocaleTimeString()}\n${approval.details}`;
      entry.append(title, details);
      for (const [label, allow] of [['Allow once', true], ['Reject', false]]) {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', async () => {
          entry.querySelectorAll('button').forEach(item => { item.disabled = true; });
          try { await apiPost('/approvals/answer', { id: approval.id, allow }); }
          catch { title.textContent = 'Approval unavailable or expired'; }
          finally { void loadApprovals(); }
        });
        entry.append(button);
      }
      items.append(entry);
    }
  } catch { panel.hidden = true; items.replaceChildren(); }
  finally { approvalRefreshRunning = false; }
}
setInterval(loadApprovals, 1500);
void loadApprovals();

// Load Data
async function loadStatus() {
  try {
    const data = await apiGet('/status');
    document.getElementById('conn-status').className = 'dot green';
    document.getElementById('conn-text').innerText = 'Connected';

    const render = (obj) => Object.entries(obj).map(([k, v]) => `
      <div class="data-item">
        <span class="data-label">${k}</span>
        <span class="data-value">${typeof v === 'object' ? JSON.stringify(v) : v}</span>
      </div>`).join('');
    
    document.getElementById('overview-runtime').innerHTML = render({
      Status: data.status,
      Uptime: Math.floor(data.uptime) + 's'
    });
    
    document.getElementById('overview-pc').innerHTML = render({
      Hostname: data.pc.hostname,
      Platform: data.pc.platform,
      'CPU Load': (data.pc.cpu * 100).toFixed(1) + '%'
    });

    document.getElementById('pc-details').innerHTML = render({
      Hostname: data.pc.hostname,
      Platform: data.pc.platform,
      'CPU Load': (data.pc.cpu * 100).toFixed(1) + '%',
      'Memory Free': (data.pc.memory.free / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      'Memory Total': (data.pc.memory.total / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      'Working Dir': data.pc.cwd
    });
  } catch (err) {
    document.getElementById('conn-status').className = 'dot red';
    document.getElementById('conn-text').innerText = 'Disconnected';
  }
}

async function loadSessions() {
  try {
    const data = await apiGet('/sessions');
    const tbody = document.getElementById('sessions-tbody');
    tbody.replaceChildren();
    for (const s of data.sessions) {
      const row = document.createElement('tr');
      for (const value of [s.id, s.status, s.provider || '-', s.model || '-']) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      const actions = document.createElement('td');
      const stop = document.createElement('button');
      stop.textContent = 'Stop';
      stop.addEventListener('click', () => void requestStop(s.id));
      const audit = document.createElement('button');
      audit.textContent = 'Audit';
      audit.addEventListener('click', () => void loadAudit(s.id));
      actions.append(stop, audit);
      row.append(actions);
      tbody.append(row);
    }
    document.getElementById('overview-sessions').innerHTML = `
      <div class="data-item"><span class="data-label">Active Agents</span><span class="data-value">${data.sessions.length}</span></div>
    `;
  } catch (e) {
    console.error(e);
  }
}

let auditCursor;
let auditSession;
async function loadAudit(sessionId, more = false) {
  try {
    if (!more || auditSession !== sessionId) {
      auditSession = sessionId;
      auditCursor = undefined;
      document.getElementById('session-audit').textContent = '';
    }
    const suffix = auditCursor ? `?cursor=${auditCursor}` : '';
    const { events, nextCursor } = await apiGet(`/sessions/${encodeURIComponent(sessionId)}/audit${suffix}`);
    for (const entry of events) {
      document.getElementById('session-audit').textContent +=
        `${new Date(entry.createdAt).toLocaleString()} ${entry.eventType} ${entry.outcome} ${entry.reasonCode} ${entry.toolName || entry.capabilityId || ''}\n`;
    }
    auditCursor = nextCursor;
    document.getElementById('audit-more').hidden = !nextCursor || events.length < 50;
  } catch {
    document.getElementById('session-control-status').textContent = 'Audit is unavailable.';
  }
}
document.getElementById('audit-more').addEventListener('click', () => {
  if (auditSession) void loadAudit(auditSession, true);
});

async function requestStop(sessionId) {
  const status = document.getElementById('session-control-status');
  try {
    const stop = await apiPost(`/sessions/${encodeURIComponent(sessionId)}/stop`, {});
    status.textContent = `Stop requested for ${sessionId}: ${stop.outcome}.`;
    if (stop.outcome !== 'stopping') return;
    const poll = async () => {
      try {
        const current = await apiGet(`/stops/${encodeURIComponent(stop.stopRequestId)}`);
        status.textContent = `Stop ${current.id}: ${current.outcome}.`;
        if (current.outcome === 'stopping') setTimeout(poll, 1000);
        else { void loadSessions(); void loadAudit(sessionId); }
      } catch { status.textContent = 'Stop status is unavailable.'; }
    };
    setTimeout(poll, 1000);
  } catch { status.textContent = 'Stop request was not accepted.'; }
}

async function loadTools() {
  try {
    const data = await apiGet('/tools');
    const tbody = document.getElementById('tools-tbody');
    tbody.innerHTML = data.tools.map(t => `
      <tr>
        <td><strong>${t.name}</strong></td>
        <td>${t.description}</td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

// Chat
const chatMessages = document.getElementById('chat-messages');
function appendChat(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerText = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

document.getElementById('chat-send').addEventListener('click', async () => {
  const sessionId = document.getElementById('chat-session-id').value;
  const input = document.getElementById('chat-input');
  const message = input.value;
  if (!sessionId || !message) return;
  
  appendChat('user', message);
  input.value = '';
  appendChat('system', 'Sending to DSH Agent...');

  try {
    const res = await apiPost('/chat', { sessionId, message });
    // The response is already added by SSE, but in case SSE fails:
    // We can just rely on SSE for 'assistant' msg.
    appendChat('system', 'Chat request completed.');
  } catch (e) {
    appendChat('system', `Error: ${e.message}`);
  }
});

// Projects
document.getElementById('project-new-session').addEventListener('click', async () => {
  const output = document.getElementById('project-output');
  try {
    const { sessionId } = await apiPost('/sessions', {});
    document.getElementById('project-session-id').value = sessionId;
    document.getElementById('chat-session-id').value = sessionId;
    output.innerText = `Session ready: ${sessionId}\n`;
    void loadSessions();
  } catch (error) { output.innerText = `Could not create session: ${error.message}`; }
});
document.querySelectorAll('.btn-action').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    const action = e.target.dataset.action;
    const output = document.getElementById('project-output');
    output.innerText += `\n> Executing ${action}...\n`;
    try {
      const sessionId = document.getElementById('project-session-id').value.trim();
      const res = await apiPost(`/project/${action}`, { sessionId });
      output.innerText += JSON.stringify(res.result, null, 2) + '\n';
    } catch (err) {
      output.innerText += `Error: ${err.message}\n`;
    }
    output.scrollTop = output.scrollHeight;
  });
});

// Event Source (SSE)
let evtSource;
function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource(`${API_BASE}/events`);
  
  const timeline = document.getElementById('activity-timeline');
  const logs = document.getElementById('logs-container');
  
  function addLog(text) {
    const d = new Date();
    const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
    logs.innerText += `[${time}] ${text}\n`;
    logs.scrollTop = logs.scrollHeight;
  }
  
  function addTimeline(content) {
    const d = new Date();
    const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    const item = document.createElement('div');
    item.className = 'timeline-item';
    const stamp = document.createElement('div');
    stamp.className = 'timeline-time';
    stamp.textContent = time;
    const body = document.createElement('div');
    body.className = 'timeline-content';
    body.textContent = content;
    item.append(stamp, body);
    timeline.prepend(item);
  }

  evtSource.addEventListener('runtime.error', e => {
    addLog(`ERROR: ${e.data}`);
  });
  
  evtSource.addEventListener('tool.completed', e => {
    const data = JSON.parse(e.data);
    addLog(`TOOL: ${data.tool} | Success: ${!data.isError}`);
    addTimeline(`Tool executed: ${data.tool} — ${data.isError ? 'Error' : 'Success'}`);
  });
  
  evtSource.addEventListener('chat.sent', e => {
    const data = JSON.parse(e.data);
    addLog(`CHAT SEND [${data.sessionId}]: ${data.message}`);
    addTimeline(`User Message (${data.sessionId})`);
  });

  evtSource.addEventListener('chat.response', e => {
    const data = JSON.parse(e.data);
    addLog(`CHAT RESPONSE [${data.sessionId}]: ${data.message}`);
    addTimeline(`Model Response (${data.sessionId})`);
    appendChat('elara', data.message);
  });

  evtSource.onerror = () => {
    console.error('SSE Error, reconnecting...');
    setTimeout(connectSSE, 5000);
  };
}

// Init
setInterval(loadStatus, 5000);
loadStatus();
loadSessions();
loadTools();
connectSSE();
