import { create } from 'zustand';

/** App-shell state that survives navigation: only the sidebar toggle is consumed (roadmap 6.8 pruned the rest). */
interface AppStore {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}));
