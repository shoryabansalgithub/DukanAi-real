> **Historical document, superseded.** Kept for the record: it describes an
> earlier state of the project (mock data, Next.js 14, Node 18/20, features
> that were never built) and is no longer maintained. Current documentation:
> [README.md](./README.md) (what is built, how to run it, the docs map),
> [AGENTS.md](./AGENTS.md) (architecture and sharp edges) and
> [docs/](./docs) (deployment, operations, release, go-live).

# DukaanAI - Setup Guide

## 🚀 Quick Start Guide

> **The current setup is README.md, "Run it with Docker" and "Run it for
> development"** (Node.js 22 from `.nvmrc`, `npm ci` at the repository root,
> MySQL 8 and Redis 7, the API on port 3002 and the web on port 3010). The
> steps below are the original front-end-only guide: the mock data they
> mention no longer exists, every page calls the API.

### Prerequisites
- **Node.js 22** (`.nvmrc`; the `engines` floor is 22.12) - [Download](https://nodejs.org/)
- **npm** - Comes with Node.js
- **Git** - [Download](https://git-scm.com/)
- **VS Code** (Recommended) - [Download](https://code.visualstudio.com/)

### Step 1: Clone or Extract Project

```bash
# If cloned from git
cd DukaanAi

# If extracted from zip
cd DukaanAi
```

### Step 2: Install Dependencies

```bash
# Navigate to frontend
cd apps/web

# Install all dependencies
npm install

# Or with yarn
yarn install
```

This will install:
- React 18
- Next.js 14
- TypeScript
- Tailwind CSS
- Framer Motion
- Recharts
- Zustand
- And all other dependencies

### Step 3: Run Development Server

```bash
# From apps/web directory
npm run dev

# Or with yarn
yarn dev
```

Output will show:
```
> dukaanai-web@0.1.0 dev
> next dev

▲ Next.js 14.0.0
- Local: http://localhost:3000
```

### Step 4: Open in Browser

Navigate to: **http://localhost:3000**

You should see the DukaanAI dashboard with:
- Top navbar with theme toggle
- Left sidebar with navigation
- Main dashboard with stats, charts, and tables

---

## 🛠️ Available Commands

### Development
```bash
# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Type check
npm run type-check

# Lint code
npm run lint
```

### Project Root Commands
```bash
cd DukaanAi

# Run dev for all apps
npm run dev

# Build all apps
npm run build

# Format all code
npm run format

# Type check all code
npm run type-check
```

---

## 📁 File Structure Quick Reference

```
DukaanAI/
├── apps/web/                   # Frontend code
│   ├── src/
│   │   ├── app/               # Pages
│   │   ├── components/        # Reusable components
│   │   ├── lib/               # Utilities
│   │   ├── hooks/             # Custom hooks
│   │   ├── store/             # State management
│   │   ├── types/             # TypeScript types
│   │   └── data/              # Mock data
│   └── package.json
├── TECH_STACK_ARCHITECTURE.md # Tech decisions
├── README.md                   # Project overview
├── ROADMAP.md                  # Development roadmap
└── PROJECT_STRUCTURE.md        # Directory guide
```

---

## 🎨 UI Features Implemented

### ✅ Pages Created
1. **Dashboard** - Main page with full UI implementation
2. **Billing (POS)** - Placeholder for billing system
3. **Customers** - Placeholder for customer management
4. **Inventory** - Placeholder for inventory management
5. **Analytics** - Placeholder for analytics
6. **AI Assistant** - Placeholder for AI features
7. **Database Manager** - Placeholder for database management
8. **Settings** - Placeholder for settings

### ✅ Components Available
- **Button** - Multiple variants (primary, secondary, outline, ghost, danger)
- **Card** - Card with header, content, footer sections
- **Badge** - Color variants (default, primary, success, warning, danger)
- **Input** - Text input with validation
- **StatCard** - Dashboard stat card with trend indicators
- **DataTable** - Reusable data table component
- **SalesChart** - Line chart for sales data
- **BarChart** - Bar chart visualization
- **PieChart** - Pie chart for distributions
- **Sidebar** - Responsive navigation sidebar
- **Navbar** - Top navigation bar

### ✅ Features
- 🌓 Dark/Light mode support
- 📱 Fully responsive design
- ⚡ Smooth animations (Framer Motion)
- 📊 Interactive charts (Recharts)
- 🎨 Professional SaaS design
- ♿ Accessibility considerations
- 🚀 Performance optimized

---

## 🔧 Configuration Files

### tsconfig.json
TypeScript configuration with:
- Strict mode enabled
- Path aliases for clean imports (`@/*`)
- Source maps for debugging

### next.config.js
Next.js configuration with:
- Image optimization
- App Router support
- SWC minification

### tailwind.config.ts
Tailwind CSS with:
- Custom color scheme
- Dark mode support
- CSS variables for theming
- Custom animations

### .env.local
Environment variables:
```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_APP_NAME=DukaanAI
```

Change `NEXT_PUBLIC_API_URL` when connecting to backend (Phase 3).

---

## 🎯 Common Tasks

### Change a Color
Edit `tailwind.config.ts` and update the color values:
```typescript
// Current primary color (purple)
primary: "262.1 80% 50.4%"
// Change to any HSL values you want
```

### Add a New Page
1. Create folder: `src/app/(app)/your-page-name/`
2. Create file: `src/app/(app)/your-page-name/page.tsx`
3. Add route to sidebar: `src/components/navigation/Sidebar.tsx`

Example:
```typescript
// src/app/(app)/your-page-name/page.tsx
export default function YourPageName() {
  return (
    <div>
      <h1>Your Page Title</h1>
      {/* Your content */}
    </div>
  );
}
```

### Use Mock Data
```typescript
import { mockProducts, mockCustomers } from '@/data/mockData';

// In your component
{mockProducts.map((product) => (
  <div key={product.id}>{product.name}</div>
))}
```

### Change Theme
Use the theme toggle button in the navbar, or:
```typescript
import { useTheme } from '@/hooks';

export function MyComponent() {
  const { theme, toggleTheme } = useTheme();
  
  return (
    <button onClick={toggleTheme}>
      Current theme: {theme}
    </button>
  );
}
```

---

## 🐛 Troubleshooting

### Port 3000 already in use
```bash
# Kill the process on port 3000
# On Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# On Mac/Linux
lsof -i :3000
kill -9 <PID>

# Or use a different port
npm run dev -- -p 3001
```

### Dependencies not installed
```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
```

### TypeScript errors
```bash
# Type check your project
npm run type-check

# Fix TypeScript errors before running
```

### Styles not working
```bash
# Tailwind CSS might not be compiled
# Delete .next folder and restart
rm -rf .next
npm run dev
```

---

## 📚 Useful VS Code Extensions

Recommended extensions for development:

- **ES7+ React/Redux/React-Native snippets** - dsznajder.es7-react-js-snippets
- **Tailwind CSS IntelliSense** - bradlc.vscode-tailwindcss
- **TypeScript Vue Plugin** - vue.volar
- **Prettier - Code formatter** - esbenp.prettier-vscode
- **ESLint** - dbaeumer.vscode-eslint
- **Thunder Client** - rangav.vscode-thunder-client (for API testing)

### VS Code Settings
```json
{
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true
  },
  "[typescriptreact]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true
  },
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  }
}
```

---

## 🔐 Environment Setup

### Adding New Environment Variables
1. Add to `.env.local`:
   ```
   NEXT_PUBLIC_NEW_VAR=value
   PRIVATE_VAR=secret
   ```

2. Access in code:
   ```typescript
   // Public variables (accessible in browser)
   const apiUrl = process.env.NEXT_PUBLIC_API_URL;
   
   // Private variables (server-side only)
   const secret = process.env.PRIVATE_VAR;
   ```

---

## 📖 Learning Resources

### Next.js
- [Next.js Documentation](https://nextjs.org/docs)
- [App Router Guide](https://nextjs.org/docs/app)
- [Next.js Examples](https://github.com/vercel/next.js/tree/canary/examples)

### TypeScript
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [TypeScript for React](https://react-typescript-cheatsheet.netlify.app/)

### Tailwind CSS
- [Tailwind CSS Docs](https://tailwindcss.com)
- [Tailwind Components](https://tailwindui.com)

### Framer Motion
- [Framer Motion Docs](https://www.framer.com/motion)
- [Animation Examples](https://www.framer.com/motion/examples)

### Zustand
- [Zustand GitHub](https://github.com/pmndrs/zustand)
- [State Management Examples](https://github.com/pmndrs/zustand/tree/main/examples)

---

## 🚀 Next Steps

1. **Explore the Codebase**
   - Check out `/src/components/` for component examples
   - Look at `/src/data/mockData.ts` for data structure
   - Review `/src/app/(app)/dashboard/page.tsx` for page structure

2. **Customize the UI**
   - Change colors in `tailwind.config.ts`
   - Modify components in `src/components/`
   - Add your branding

3. **Create New Pages**
   - Use dashboard as a template
   - Import components from `src/components/`
   - Use mock data from `src/data/`

4. **Phase 3: Backend Setup**
   - See `ROADMAP.md` for Phase 3 tasks
   - Set up NestJS API
   - Configure database with Prisma
   - Connect frontend to backend APIs

---

## 💬 Support & Documentation

- **Tech Stack Guide**: See `TECH_STACK_ARCHITECTURE.md`
- **Project Roadmap**: See `ROADMAP.md`
- **Structure Guide**: See `PROJECT_STRUCTURE.md`
- **Main README**: See `README.md`

---

**Last Updated**: May 19, 2026
**Status**: Phase 2 Complete ✅
**Ready for**: Phase 3 Development
