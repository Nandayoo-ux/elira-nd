import json
import os

transcript_path = r'C:\Users\LENOVO\.gemini\antigravity-ide\brain\2c9a210e-ff91-4fdd-a725-d24abfebf627\.system_generated\logs\transcript.jsonl'
edits = []

try:
    with open(transcript_path, 'r', encoding='utf-8') as f:
        for line in f:
            try:
                step = json.loads(line)
                if 'tool_calls' in step:
                    for call in step['tool_calls']:
                        if call['name'] in ['replace_file_content', 'multi_replace_file_content']:
                            args = call.get('args', {})
                            if isinstance(args, str):
                                args = json.loads(args, strict=False)
                            target = args.get('TargetFile', '')
                            if any(x in target for x in ['whatsapp-baileys', 'elara-access.ts', 'evaluate.ts', 'index.ts', 'access.json']):
                                edits.append({
                                    'tool': call['name'],
                                    'args': args,
                                    'target': target
                                })
            except:
                pass
except:
    pass

print(f"Found {len(edits)} edits.")
# Reverse the edits
edits.reverse()

for edit in edits:
    target_file = edit['target'].strip('\"\'').replace('\\', '/')
    if not os.path.exists(target_file):
        print(f"File not found: {target_file}")
        continue
    
    with open(target_file, 'r', encoding='utf-8') as f:
        content = f.read()

    print(f"Undoing edit on {target_file} (Tool: {edit['tool']})")
    
    if edit['tool'] == 'replace_file_content':
        target = edit['args'].get('TargetContent', '')
        replacement = edit['args'].get('ReplacementContent', '')
        content = content.replace(replacement, target)
        
    elif edit['tool'] == 'multi_replace_file_content':
        chunks = edit['args'].get('ReplacementChunks', [])
        if isinstance(chunks, str):
            try:
                chunks = json.loads(chunks, strict=False)
            except Exception as e:
                print("Failed to parse chunks:", e)
                continue
        for chunk in chunks:
            target = chunk.get('TargetContent', '')
            replacement = chunk.get('ReplacementContent', '')
            content = content.replace(replacement, target)

    with open(target_file, 'w', encoding='utf-8') as f:
        f.write(content)

print("Done undoing.")
