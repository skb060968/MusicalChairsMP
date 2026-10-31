import re

with open('firebase rules.txt', encoding='utf-8') as f:
    content = f.read()

# Find the game .write value inside chairs-rooms
# It starts after: "game": {  ".write": "
# and ends before: ".validate": "newData.hasChildren

chairs_start = content.index('"chairs-rooms"')

# Find the exact .write start and end within chairs-rooms game node
write_key = '".write": "auth != null && data.exists() && newData.exists() && data.child(\'status\').val() === \'playing\''
write_start = content.index(write_key, chairs_start)

# The .write value ends at the closing `",` before the next key on a new line
# Find the .validate that follows the .write
validate_key = '\n          ".validate": "newData.hasChildren([\'status\''
validate_pos = content.index(validate_key, write_start)

# The .write ends just before validate_pos - it's: ...",\n
# Find the last `",` before validate_pos
write_end = content.rindex('",', write_start, validate_pos) + 2  # include the ",

old_write = content[write_start:write_end]

print(f"write_start={write_start}, write_end={write_end}")
print(f"Old write length: {len(old_write)}")
print(f"Old write last 100 chars: {repr(old_write[-100:])}")

# Check old write opens and closes parens are balanced inside the string value
# (the value is between the outer " marks)
val_start = old_write.index('"', 0) + 1  # skip the ".write": " 
# find the position of  : "
colon_quote = old_write.index(': "') + 3
val_end = old_write.rindex('"')
rule_expr = old_write[colon_quote:val_end]
opens = rule_expr.count('(')
closes = rule_expr.count(')')
print(f"Rule expression opens={opens} closes={closes} diff={opens-closes}")
