import json
import os
transcript_path = r'C:\Users\LENOVO\.gemini\antigravity-ide\brain\2c9a210e-ff91-4fdd-a725-d24abfebf627\.system_generated\logs\transcript.jsonl'
edits = []
with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        try:
            step = json.loads(line)
            if 'tool_calls' in step:
                for call in step['tool_calls']:
                    if call['name'] in ['replace_file_content', 'multi_replace_file_content']:
                        args = call.get('args', {})
                        if isinstance(args, str):
                            args = json.loads(args)
                        target = args.get('TargetFile', '')
                        if any(x in target for x in ['whatsapp-baileys', 'elara-access.ts', 'evaluate.ts', 'index.ts', 'access.json']):
                            edits.append({'tool': call['name'], 'target': target})
        except:
            pass
print('Found edits:', len(edits))
for edit in edits:
    target_file = edit['target']
    print(f'Raw target: {target_file}')
    target_file = target_file.strip('\"\'').replace('\\', '/')
    print(f'Clean target: {target_file}')
    print(f'Exists: {os.path.exists(target_file)}')
