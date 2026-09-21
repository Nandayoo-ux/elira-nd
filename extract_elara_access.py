import json

first_edit = {}
try:
    with open('edits.log', 'r', encoding='utf-8') as f:
        for line in f:
            try:
                step = json.loads(line)
                if 'tool_calls' in step:
                    for call in step['tool_calls']:
                        if call['name'] in ['replace_file_content', 'multi_replace_file_content']:
                            args = call.get('args', {})
                            target = args.get('TargetFile', '')
                            if 'elara-access.ts' in target:
                                if target not in first_edit:
                                    first_edit[target] = []
                                first_edit[target].append(args)
            except:
                pass
except:
    pass

for target, edits in first_edit.items():
    print(f"File: {target}")
    # Print the very first edit to see what it changed
    first = edits[0]
    if 'TargetContent' in first:
        print("First TargetContent:")
        print(first['TargetContent'])
    elif 'ReplacementChunks' in first:
        chunks = first['ReplacementChunks']
        if isinstance(chunks, str):
            chunks = json.loads(chunks)
        for i, chunk in enumerate(chunks):
            print(f"Chunk {i} TargetContent:")
            print(chunk.get('TargetContent'))
