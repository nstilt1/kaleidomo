import { Menu, MenuItem, Submenu, PredefinedMenuItem } from "@tauri-apps/api/menu";

export type AppMenuHandles = {
  loadImagePreset: MenuItem;
  saveImagePreset: MenuItem;
  loadVideoPreset: MenuItem;
  saveVideoPreset: MenuItem;
  loadProject: MenuItem;
  saveProject: MenuItem;
};

function dispatchCreatePageEvent(eventName: string) {
  window.dispatchEvent(new CustomEvent(eventName));
}

export async function setupAppMenu(): Promise<AppMenuHandles> {
  const loadImagePreset = await MenuItem.new({
    id: "load-image-preset",
    text: "Load Image Preset...",
    action: () => dispatchCreatePageEvent("menu-load-image-preset"),
  });

  const saveImagePreset = await MenuItem.new({
    id: "save-image-preset",
    text: "Save Image Preset",
    action: () => dispatchCreatePageEvent("menu-save-image-preset"),
  });

  const loadVideoPreset = await MenuItem.new({
    id: "load-video-preset",
    text: "Load Video Preset...",
    action: () => dispatchCreatePageEvent("menu-load-video-preset"),
  });

  const saveVideoPreset = await MenuItem.new({
    id: "save-video-preset",
    text: "Save Video Preset",
    action: () => dispatchCreatePageEvent("menu-save-video-preset"),
  });

  const loadProject = await MenuItem.new({
    id: "load-project-preset",
    text: "Load Project...",
    action: () => dispatchCreatePageEvent("menu-load-project"),
  });

  const saveProject = await MenuItem.new({
    id: "save-project-preset",
    text: "Save Project",
    action: () => dispatchCreatePageEvent("menu-save-project"),
  });

  const appSubmenu = await Submenu.new({
    text: "App",
    items: [],
  });

  const fileSubmenu = await Submenu.new({
    text: "File",
    items: [
      loadImagePreset,
      saveImagePreset,
      loadVideoPreset,
      saveVideoPreset,
      loadProject,
      saveProject,
    ],
  });

  const editSubmenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });

  const menu = await Menu.new({
    items: [appSubmenu, fileSubmenu, editSubmenu],
  });

  await menu.setAsAppMenu();

  return {
    loadImagePreset,
    saveImagePreset,
    loadVideoPreset,
    saveVideoPreset,
    loadProject,
    saveProject,
  };
}