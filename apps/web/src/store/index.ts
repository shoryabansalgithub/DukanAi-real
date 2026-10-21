import { create } from 'zustand';

/** App-shell state that survives navigation: only the sidebar toggle is consumed (roadmap 6.8 pruned the rest). */
interface AppStore {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  // The phone menu (below md; the sidebar is always shown from md up) starts
  // closed: open, its overlay covered the POS on every page load (roadmap 9.19).
  sidebarOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}));
