import os
import json
import time
from deep_translator import GoogleTranslator

# Configuration
LOCALES_DIR = './_locales'
NEW_STRINGS_FILE = 'new_strings.json'

def update_locales():
    # 1. Load the new strings
    if not os.path.exists(NEW_STRINGS_FILE):
        print(f"❌ {NEW_STRINGS_FILE} not found.")
        return

    with open(NEW_STRINGS_FILE, 'r', encoding='utf-8') as f:
        new_entries = json.load(f)

    # 2. Get list of all locale folders
    locales = [d for d in os.listdir(LOCALES_DIR) if os.path.isdir(os.path.join(LOCALES_DIR, d))]
    
    for locale in locales:
        # Standardize language code (e.g., pt_BR -> pt, es_419 -> es)
        lang_code = locale.split('_')[0]
        
        # English is our source; we keep descriptions for EN only
        is_source = (lang_code == 'en')
        
        print(f"🌐 Processing: {locale}...")
        process_messages_file(locale, new_entries, lang_code, is_source)

def process_messages_file(locale, new_entries, lang_code, is_source):
    file_path = os.path.join(LOCALES_DIR, locale, 'messages.json')
    
    if not os.path.exists(file_path):
        return

    with open(file_path, 'r+', encoding='utf-8') as f:
        try:
            current_data = json.load(f)
        except json.JSONDecodeError:
            current_data = {}

        updated = False
        for key, entry in new_entries.items():
            if key not in current_data:
                source_text = entry.get('message', '')
                
                if is_source:
                    # Keep everything for English
                    current_data[key] = entry
                else:
                    # Translate message, empty the description
                    try:
                        time.sleep(0.3) # Slight delay to avoid rate limits
                        translated_text = GoogleTranslator(source='en', target=lang_code).translate(source_text)
                        current_data[key] = {
                            "message": translated_text,
                            "description": ""
                        }
                    except Exception as e:
                        print(f"  ❌ Error translating '{key}' for {locale}: {e}")
                        continue
                
                updated = True

        if updated:
            f.seek(0)
            json.dump(current_data, f, indent=2, ensure_ascii=False)
            f.truncate()
            print(f"  ✅ Updated.")
        else:
            print(f"  ℹ️ Already up to date.")

if __name__ == "__main__":
    update_locales()
