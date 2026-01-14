import os
import re

def fix_imports(directory):
    import_regex = re.compile(r"(import\s+.*?\s+from\s+['\"])(\.\.?/.*?)(['\"])")
    
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith('.ts') and not file.endswith('.d.ts'):
                path = os.path.join(root, file)
                with open(path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                new_content = import_regex.sub(lambda m: f"{m.group(1)}{m.group(2)}.js{m.group(3)}" if not m.group(2).endswith('.js') else m.group(0), content)
                
                if new_content != content:
                    with open(path, 'w', encoding='utf-8') as f:
                        f.write(new_content)
                    print(f"Fixed imports in {path}")

if __name__ == "__main__":
    fix_imports('c:/Users/rmkoc/Downloads/vitapp2/vitality_api-main/vitality_api-main/src')
