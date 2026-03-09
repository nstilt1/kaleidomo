import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

export const saveConfig = async (currentSettings: any, imagePath: string) => {
  try {
    const filePath = await save({
      filters: [{ name: 'Kaleidoscope Config', extensions: ['json'] }],
      defaultPath: 'kaleidoscope_settings.json'
    });

    if (filePath) {
      const config = {
        imagePath,
        settings: currentSettings,
        timestamp: new Date().toISOString()
      };
      await writeTextFile(filePath, JSON.stringify(config, null, 2));
      alert("Settings saved successfully!");
    }
  } catch (err) {
    console.error("Failed to save:", err);
  }
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
