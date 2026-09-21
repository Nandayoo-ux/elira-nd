import json
import sys

transcript_path = r'C:\Users\LENOVO\.gemini\antigravity-ide\brain\2c9a210e-ff91-4fdd-a725-d24abfebf627\.system_generated\logs\transcript.jsonl'
targets = ['plugins/elara-access.ts', 'packages/policy/evaluate.ts']
first_state = {}

with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        try:
            step = json.loads(line)
            if 'tool_calls' in step:
                for call in step['tool_calls']:
                    if call['name'] in ['replace_file_content', 'multi_replace_file_content']:
                        args = call.get('args') or call.get('arguments')
                        if isinstance(args, str):
                            args = json.loads(args)
                        target_file = args.get('TargetFile', '').replace('\\', '/')
                        target_file = target_file.strip('\"\'')
                        for target in targets:
                            if target_file.endswith(target):
                                if target not in first_state:
                                    first_state[target] = args
        except Exception as e:
            pass

print('Found edits:', list(first_state.keys()))
for target, args in first_state.items():
    print(f'=== {target} ===')
    if 'TargetContent' in args:
        print(args['TargetContent'])
    elif 'ReplacementChunks' in args:
        if isinstance(args['ReplacementChunks'], str):
            chunks = json.loads(args['ReplacementChunks'])
        else:
            chunks = args['ReplacementChunks']
        for chunk in chunks:
            print("--- CHUNK TARGET ---")
            print(chunk.get('TargetContent', ''))
