import fs from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { default as SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt';

async function main() {
  console.log('--- STARTING PERSONA TEST ---');

  const patchPath = new URL('../profiles/local/cordis.patch.yml', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const patchContent = fs.readFileSync(patchPath, 'utf8');

  // We extract the personaPrefix strictly via Regex since it's known shape
  const personaMatch = patchContent.match(/personaPrefix:\s*\|([\s\S]+?)(?=\n[^\s]|$)/);
  if (!personaMatch) {
    throw new Error('Could not find personaPrefix in cordis.patch.yml');
  }
  
  // Clean up yaml indentation
  const rawLines = personaMatch[1].split('\n');
  const personaPrefix = rawLines.map(l => l.replace(/^ {10}/, '')).join('\n').trim();

  if (!personaPrefix.includes('You are ELARA')) {
    throw new Error('Extracted personaPrefix does not look correct.');
  }

  const ctx = new Context();
  
  // 1. Core harness SystemPrompt handles global config
  ctx.plugin(SystemPrompt, {
    personaPrefix: personaPrefix
  });

  // 2. We inject elara-core to make sure it doesn't duplicate the persona
  const elaraCore = await import('../plugins/elara-core.ts');
  ctx.plugin(elaraCore.default || elaraCore);

  await new Promise(r => setTimeout(r, 500));

  // 3. Assemble and render the final model-facing prompt
  const assembly = await ctx.systemPrompt.assemble();
  const rendered = renderPrompt(assembly);

  console.log('--- ASSEMBLED SYSTEM PROMPT ---');
  console.log(rendered);
  console.log('-------------------------------');

  // 4. Assert exact occurrence
  const targetToken = 'You are ELARA, a female-presenting personal AI assistant';
  const personaCount = (rendered.match(new RegExp(targetToken, 'g')) || []).length;
  
  if (personaCount !== 1) {
    throw new Error(`Assertion failed: Expected persona to be present exactly once, found ${personaCount} times.`);
  }

  console.log('✅ Persona test passed: Persona is present exactly once in the assembled system prompt.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Persona test failed:', err);
  process.exit(1);
});
