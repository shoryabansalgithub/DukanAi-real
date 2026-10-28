> **Historical document, superseded.** Kept for the record: it describes an
> earlier state of the project (mock data, Next.js 14, Node 18/20, features
> that were never built) and is no longer maintained. Current documentation:
> [README.md](./README.md) (what is built, how to run it, the docs map),
> [AGENTS.md](./AGENTS.md) (architecture and sharp edges) and
> [docs/](./docs) (deployment, operations, release, go-live).

## DukaanAI Project Structure

```
DukaanAI/
│
├── apps/
│   └── web/                           # Next.js 14 Frontend Application
│       ├── src/
│       │   ├── app/                   # App Router Pages
│       │   │   ├── dashboard/         # Dashboard page
│       │   │   ├── billing/           # POS Billing page
│       │   │   ├── customers/         # Customers page
│       │   │   ├── inventory/         # Inventory page
│       │   │   ├── analytics/         # Analytics page
│       │   │   ├── ai-assistant/      # AI Assistant page
│       │   │   ├── database/          # Database Manager page
│       │   │   ├── settings/          # Settings page
│       │   │   ├── layout.tsx         # Root layout
│       │   │   ├── page.tsx           # Home page
│       │   │   └── globals.css        # Global styles
│       │   │
│       │   ├── components/            # Reusable Components
│       │   │   ├── ui/                # Primitive UI components
│       │   │   │   ├── Button.tsx     # Button component
│       │   │   │   ├── Card.tsx       # Card components
│       │   │   │   ├── Badge.tsx      # Badge component
│       │   │   │   └── Input.tsx      # Input component
│       │   │   │
│       │   │   ├── dashboard/         # Dashboard components
│       │   │   │   ├── StatCard.tsx   # Stats card component
│       │   │   │   └── DataTable.tsx  # Data table component
│       │   │   │
│       │   │   ├── charts/            # Chart components
│       │   │   │   └── Charts.tsx     # Recharts components
│       │   │   │
│       │   │   ├── navigation/        # Navigation components
│       │   │   │   ├── Sidebar.tsx    # Sidebar navigation
│       │   │   │   └── Navbar.tsx     # Top navbar
│       │   │   │
│       │   │   ├── forms/             # Form components (Phase 3)
│       │   │   └── layout/            # Layout wrapper
│       │   │       └── RootLayout.tsx # Main layout component
│       │   │
│       │   ├── lib/                   # Utilities & Helpers
│       │   │   ├── api.ts             # API client setup
│       │   │   └── utils.ts           # Utility functions
│       │   │
│       │   ├── hooks/                 # Custom React Hooks
│       │   │   └── index.ts           # Theme & media query hooks
│       │   │
│       │   ├── store/                 # Zustand State Management
│       │   │   └── index.ts           # Global app store
│       │   │
│       │   ├── types/                 # TypeScript Types
│       │   │   └── index.ts           # Type definitions
│       │   │
│       │   └── data/                  # Mock Data
│       │       └── mockData.ts        # All mock data
│       │
│       ├── public/                    # Static assets
│       │   └── favicon.ico
│       │
│       ├── package.json               # Dependencies
│       ├── tsconfig.json              # TypeScript config
│       ├── next.config.js             # Next.js config
│       ├── tailwind.config.ts         # Tailwind config
│       ├── postcss.config.js          # PostCSS config
│       ├── .eslintrc.json             # ESLint config
│       └── .env.local                 # Environment variables
│
├── packages/                          # Shared packages (Phase 3)
│   ├── types/                         # Shared types
│   ├── utils/                         # Shared utilities
│   └── ui/                            # Shared UI components
│
├── TECH_STACK_ARCHITECTURE.md         # Tech stack documentation
├── README.md                          # Project README
├── ROADMAP.md                         # Development roadmap
├── PROJECT_STRUCTURE.md               # This file
├── SETUP_GUIDE.md                     # Setup instructions
├── package.json                       # Root package.json
├── .gitignore                         # Git ignore rules
├── .prettierrc                        # Prettier config
└── .prettierignore                    # Prettier ignore rules
```

## 🔍 Directory Details

### `src/app/` - Next.js App Router Pages
- **Page-based routing**: Each folder = route
- **layout.tsx**: Applies to all pages in that folder
- **page.tsx**: The actual page component

### `src/components/` - Reusable Components
- **ui/**: Primitive components (Button, Card, Input, Badge)
- **dashboard/**: Dashboard-specific components
- **charts/**: Chart/visualization components
- **navigation/**: Navigation components (Sidebar, Navbar)
- **forms/**: Form components (added in Phase 3)
- **layout/**: Layout wrapper components

### `src/lib/` - Utilities
- **api.ts**: Axios instance with interceptors
- **utils.ts**: Helper functions (formatting, calculations, etc.)

### `src/hooks/` - Custom React Hooks
- **useTheme()**: Theme toggle hook
- **useMediaQuery()**: Media query hook
- **useIsMobile()**: Mobile detection hook

### `src/store/` - Global State (Zustand)
- Single store for global app state
- User, shop, theme, notifications
- Actions for state updates

### `src/types/` - TypeScript Types
- All type definitions
- Domain models (User, Product, Customer, Invoice, etc.)

### `src/data/` - Mock Data
- Mock products, customers, transactions
- Sample data for all features
- Used in development before backend

## 📊 Component Hierarchy

```
RootLayout
├── Sidebar
│   └── Navigation Links
├── Navbar
│   ├── Theme Toggle
│   ├── Notifications
│   └── User Profile
└── Main Content
    └── Page Components
        ├── StatCard
        ├── SalesChart
        ├── DataTable
        └── Other Page-Specific Components
```

## 🎯 Development Workflow

### Adding a New Page
1. Create folder in `src/app/(app)/[pageName]/` (app pages; public marketing pages live in `src/app/(marketing)/`)
2. Create `page.tsx` inside
3. Import components and use mock data
4. Export as default

### Adding a New Component
1. Create file in `src/components/[category]/ComponentName.tsx`
2. Use React.forwardRef for ref support
3. Export as default
4. Add TypeScript types for props

### Using Mock Data
```typescript
import { mockProducts, mockCustomers } from '@/data/mockData';

// Use in components
<DataTable data={mockProducts} columns={...} />
```

### Adding Styles
- Use Tailwind classes for most styling
- Global styles in `globals.css`
- Component-specific CSS as needed

## 🔧 Important Files

| File | Purpose |
|------|---------|
| `tsconfig.json` | TypeScript configuration |
| `next.config.js` | Next.js configuration |
| `tailwind.config.ts` | Tailwind CSS configuration |
| `postcss.config.js` | PostCSS/Autoprefixer config |
| `.eslintrc.json` | ESLint rules |
| `.prettierrc` | Code formatting rules |
| `.env.local` | Environment variables |
| `package.json` | Dependencies and scripts |

## 📝 Key Configuration Details

### Tailwind CSS Setup
- Uses CSS variables for theming
- Dark mode support via `dark:` prefix
- Custom color scheme defined in `tailwind.config.ts`

### TypeScript Paths
- `@/*` points to `src/`
- Import like: `import { Button } from '@/components/ui/Button'`

### Environment Variables
- `NEXT_PUBLIC_API_URL` - Backend API base URL
- Add more in `.env.local` as needed

## 🚀 Next: Phase 3 Structure

When Phase 3 starts, the structure will expand:

```
DukaanAI/
├── apps/
│   ├── web/          # Current frontend ✅
│   ├── api/          # NestJS backend 🔜
│   └── ai-service/   # FastAPI AI service 🔜
├── packages/         # Shared code
├── docker/           # Docker files
└── scripts/          # Automation scripts
```

---

**Last Updated**: May 19, 2026
**Status**: Phase 2 Complete ✅
