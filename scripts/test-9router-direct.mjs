import { request } from 'node:http';

async function test9RouterOpenAI() {
  const payload = {
    model: 'gemini-2.5-pro',
    messages: [{
      role: 'user',
      content: 'Perform a web search for the query: test 123'
    }]
  };

  const body = JSON.stringify(payload);

  const req = request('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer sk-dummy'
    }
  }, (res) => {
    console.log('Status (OpenAI):', res.statusCode);
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('Response (OpenAI):', data.substring(0, 500));
    });
  });

  req.on('error', (e) => {
    console.error('Request Error:', e.message);
  });
  req.write(body);
  req.end();
}

async function test9RouterAnthropic() {
  const payload = {
    model: 'gemini-2.5-pro',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'Perform a web search for the query: test 123' }],
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
  };

  const body = JSON.stringify(payload);

  const req = request('http://localhost:20128/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-dummy',
      'anthropic-version': '2023-06-01'
    }
  }, (res) => {
    console.log('Status (Anthropic):', res.statusCode);
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('Response (Anthropic):', data.substring(0, 500));
    });
  });

  req.on('error', (e) => {
    console.error('Request Error:', e.message);
  });
  req.write(body);
  req.end();
}

test9RouterOpenAI();
setTimeout(test9RouterAnthropic, 1000);
