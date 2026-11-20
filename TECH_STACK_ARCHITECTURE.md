# DukaanAI - Production-Grade Tech Stack Architecture

> **Status (roadmap 8.6):** this is the original design rationale, kept for the
> "why" behind each choice. The stack as built differs in places: Next.js 16 on
> React 19, Node 22, BullMQ (`@nestjs/bullmq`), class-validator config domains,
> and no Radix UI, shadcn/ui, TanStack Query or next-themes (removed as unused,
> roadmap 6.8). `AGENTS.md`, the `package.json` files and
> `docs/architecture/environment-architecture.md` describe what runs today.

## Executive Summary

DukaanAI requires a **scalable, enterprise-grade, AI-first retail OS** architecture that can handle real-time transactions, complex analytics, AI features, and multi-shop operations at scale.

---

## 🏗️ PHASE 1: TECH STACK ARCHITECTURE

### 📱 **FRONTEND STACK**

#### **Primary Framework: Next.js 16 (App Router, React 19)**
- **Why**: 
  - Server-side rendering for SEO and performance
  - Built-in API routes for quick backend prototyping
  - Incremental Static Regeneration (ISR) for dashboard data
  - Excellent TypeScript support out-of-the-box
  - Vercel deployment ecosystem (scales automatically)
  - File-based routing reduces boilerplate
  - App Router provides fine-grained caching control

#### **Language: TypeScript**
- **Why**:
  - Type safety prevents runtime errors in a mission-critical POS system
  - Better IDE autocomplete for productivity
  - Excellent refactoring capabilities
  - Self-documenting code reduces onboarding time
  - Enterprise requirement for large teams

#### **Styling: Tailwind CSS v4**
- **Why**:
  - Utility-first approach for rapid UI development
  - Consistent design system enforcement
  - Minimal CSS bundle size (tree-shaking)
  - Dark mode built-in (DukaanAI needs this)
  - Integrates perfectly with shadcn/ui

#### **Component Library: shadcn/ui**
- **Why**:
  - Copy-paste components (you own the code, not locked in)
  - Built on Radix UI (accessibility WAI-ARIA compliant)
  - Fully customizable and extendable
  - Zero vendor lock-in
  - Perfect for complex enterprise components (tables, modals, forms)

#### **UI Animation: Framer Motion v11**
- **Why**:
  - Production-ready motion library
  - Performance optimized (GPU acceleration)
  - Gesture support for mobile interactions
  - Makes premium SaaS feel responsive
  - Small bundle size (~50KB gzip)

#### **Charting: Recharts v2**
- **Why**:
  - React-first charting library
  - Server component compatible with Next.js App Router
  - Small bundle (composable, only load what you use)
  - Beautiful default styling
  - Perfect for analytics dashboards

#### **Icons: Lucide React**
- **Why**:
  - Consistent icon system
  - Tree-shakeable (only exported icons are bundled)
  - Beautiful, modern icon set
  - Perfect for startup aesthetic

#### **State Management: Zustand**
- **Why**:
  - Minimal boilerplate vs Redux
  - TypeScript-first design
  - Tiny bundle size (2KB)
  - Devtools support
  - Easy to learn and maintain
  - Perfect for this project's moderate complexity

#### **Forms: React Hook Form + Zod**
- **Why**:
  - Zero re-renders on field change
  - Built-in validation with Zod
  - Small bundle footprint
  - TypeScript validation schemas
  - Perfect for complex billing forms

#### **HTTP Client: TanStack Query (React Query) v5 + Axios**
- **Why**:
  - Server state management
  - Automatic caching and background refetching
  - Real-time data synchronization
  - Offline support (crucial for POS systems)
  - Infinite query support for pagination

---

### 🛠️ **BACKEND STACK**

#### **Framework: NestJS v10+**
- **Why**:
  - Enterprise-grade Node.js framework
  - Dependency Injection for testable code
  - Built-in validation, guards, pipes
  - Microservice-ready architecture
  - Excellent TypeScript support
  - Modular folder structure enforced
  - Perfect for scaling to multiple services

#### **Language: TypeScript**
- **Why**:
  - Full-stack type safety from DB to frontend
  - Reduces bugs in financial transactions (billing)
  - Excellent for team collaboration

#### **Runtime: Node.js 22 LTS**
- **Why**:
  - Long-term support version
  - Excellent performance
  - Production-ready
  - Great ecosystem

---

### 💾 **DATABASE STACK**

#### **Primary Database: MySQL 8.0+ (Cloud: AWS RDS / PlanetScale)**
- **Why**:
  - ACID compliance crucial for billing/transactions
  - Horizontal scaling via read replicas
  - PlanetScale provides serverless MySQL (scales automatically)
  - Excellent for financial data integrity
  - Strong foreign key relationships for inventory tracking
  - Industry standard for retail systems

#### **ORM: Prisma v5+**
- **Why**:
  - Type-safe database queries
  - Auto-generated migrations
  - Beautiful schema.prisma DSL
  - Prisma Studio for visual DB management
  - Excellent TypeScript integration
  - Query optimization
  - Built-in connection pooling

#### **Vector Database: Pinecone / Weaviate** (Optional for AI embeddings)
- **Why**:
  - Store product embeddings for AI recommendations
  - Similarity search for smart product recommendations
  - Semantic search capabilities

---

### 🔍 **SEARCH & INDEXING**

#### **Search Engine: Elasticsearch v8+**
- **Why**:
  - Full-text search for products, customers, invoices
  - Fuzzy search built-in
  - Typo tolerance ("magi" → "maggi")
  - Real-time indexing
  - Scales to millions of products
  - Perfect for "Smart Product Search"

#### **Alternative (Lightweight): MeiliSearch** (If Elasticsearch is overkill initially)
- **Why**:
  - Faster to setup
  - Smaller resource footprint
  - Built-in typo tolerance
  - Can migrate to Elasticsearch later

**Decision**: Start with **MeiliSearch for MVP**, migrate to **Elasticsearch at scale**.

---

### ⚡ **CACHING & REAL-TIME**

#### **Cache Layer: Redis v7+**
- **Why**:
  - Sub-millisecond latency
  - Perfect for session storage
  - Rate limiting (crucial for API gateway)
  - Real-time inventory sync
  - Pub/Sub for real-time notifications
  - Cache invalidation strategies

#### **Real-Time Communication: Socket.IO v4+**
- **Why**:
  - WebSocket with automatic fallback
  - Perfect for real-time order updates
  - Inventory synchronization across terminals
  - Live notification system
  - Works with NestJS via @nestjs/websockets

---

### 🔐 **AUTHENTICATION & AUTHORIZATION**

#### **Authentication: NextAuth.js v5 (App Router compatible)**
- **Why**:
  - Seamless Next.js integration
  - JWT + Session support
  - OAuth providers (Google, GitHub)
  - Role-based access control (RBAC)
  - Multi-shop tenant support
  - Type-safe in TypeScript

#### **API Authentication: JWT (Access + Refresh tokens)**
- **Why**:
  - Stateless authentication
  - Perfect for mobile apps later
  - Industry standard

#### **Authorization: CASL (Role-based Access Control)**
- **Why**:
  - Define abilities/permissions declaratively
  - Enforce roles (admin, manager, cashier, owner)
  - Perfect for multi-user shops

---

### 🤖 **AI & MACHINE LEARNING STACK**

#### **AI Backend: FastAPI (Python microservice)**
- **Why**:
  - Lightning-fast Python framework
  - Perfect for ML model serving
  - Async support
  - Auto OpenAPI docs
  - Separate from Node.js backend (can scale independently)

#### **LLM Integration: OpenAI API + Langchain**
- **Why**:
  - AI Assistant chatbot
  - Business insights generation
  - Prompt engineering for retail analytics
  - Voice billing description generation

#### **OCR: Tesseract + Paddle OCR (Python)**
- **Why**:
  - Invoice scanning
  - Receipt recognition
  - Open-source, no API costs

#### **Voice Processing: Deepgram API (Voice-to-Text)**
- **Why**:
  - High-accuracy speech recognition
  - Indian language support (Hindi, Regional)
  - Real-time transcription for voice billing

#### **Time Series Analytics: Prophet / AutoTS**
- **Why**:
  - Predictive analytics for sales forecasting
  - Inventory demand prediction
  - Anomaly detection in sales patterns

---

### 📊 **ANALYTICS & MONITORING**

#### **Analytics Database: ClickHouse (optional, for massive scale)**
- **Why**:
  - Purpose-built for OLAP analytics
  - Fast aggregations on billions of rows
  - Real-time dashboard updates
  - Can be added later without refactoring

#### **Monitoring: Prometheus + Grafana**
- **Why**:
  - Open-source monitoring stack
  - Self-hosted (privacy)
  - Beautiful dashboards
  - Alert system

#### **Error Tracking: Sentry**
- **Why**:
  - Real-time error monitoring
  - Source map support
  - Session replay
  - Performance monitoring

---

### 🚀 **DEPLOYMENT & INFRASTRUCTURE**

#### **Frontend Hosting: Vercel**
- **Why**:
  - Next.js creators (optimized integration)
  - Automatic deployments from Git
  - CDN globally distributed
  - Edge Functions for API routes
  - Free SSL
  - Scales automatically

#### **Backend Hosting: AWS ECS + RDS**
- **Why**:
  - Container orchestration
  - Managed database (RDS MySQL)
  - Auto-scaling groups
  - Load balancing
  - Industry standard

#### **Alternative: Railway / Render** (Simpler initially)
- **Why**:
  - Easier than AWS for MVP
  - Auto-scaling included
  - Perfect for startup phase
  - Can migrate to AWS later

#### **Message Queue: BullMQ (Redis-based)**
- **Why**:
  - Background job processing
  - Bill generation queuing
  - Invoice PDF generation async
  - Email sending async

#### **File Storage: AWS S3**
- **Why**:
  - Store product images, invoices PDFs
  - CDN integration via CloudFront
  - Versioning
  - Lifecycle policies

---

### 🏗️ **FOLDER STRUCTURE**

```
DukaanAI/
├── apps/
│   ├── web/                    # Next.js frontend
│   │   ├── src/
│   │   │   ├── app/           # App Router pages
│   │   │   │   ├── (auth)/
│   │   │   │   ├── (dashboard)/
│   │   │   │   ├── api/
│   │   │   │   └── layout.tsx
│   │   │   ├── components/    # Reusable UI components
│   │   │   │   ├── ui/        # shadcn/ui
│   │   │   │   ├── dashboard/
│   │   │   │   ├── forms/
│   │   │   │   ├── charts/
│   │   │   │   └── navigation/
│   │   │   ├── lib/           # Utilities, helpers
│   │   │   │   ├── api.ts
│   │   │   │   ├── auth.ts
│   │   │   │   └── validators/
│   │   │   ├── hooks/         # Custom React hooks
│   │   │   ├── store/         # Zustand state management
│   │   │   ├── types/         # TypeScript types
│   │   │   └── styles/        # Global styles
│   │   └── package.json
│   │
│   ├── api/                    # NestJS backend
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── users/
│   │   │   │   ├── products/
│   │   │   │   ├── billing/
│   │   │   │   ├── customers/
│   │   │   │   ├── inventory/
│   │   │   │   ├── analytics/
│   │   │   │   └── ai/
│   │   │   ├── common/
│   │   │   │   ├── guards/
│   │   │   │   ├── pipes/
│   │   │   │   ├── filters/
│   │   │   │   └── interceptors/
│   │   │   ├── database/
│   │   │   │   ├── prisma/
│   │   │   │   └── migrations/
│   │   │   └── config/
│   │   └── package.json
│   │
│   └── ai-service/            # FastAPI Python service
│       ├── main.py
│       ├── services/
│       │   ├── voice_billing.py
│       │   ├── ocr_service.py
│       │   ├── ai_insights.py
│       │   └── fuzzy_search.py
│       ├── models/
│       └── requirements.txt
│
├── packages/                   # Shared packages
│   ├── types/                 # Shared TypeScript types
│   ├── utils/                 # Shared utilities
│   └── ui/                    # Shared UI components
│
├── docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.web
│   └── docker-compose.yml
│
├── scripts/
│   ├── setup.sh
│   └── deploy.sh
│
└── README.md
```

---

## 📋 **DATABASE SCHEMA OVERVIEW**

```
Core Entities:
├── Users (multi-shop support)
├── Shops (tenant data)
├── Products
├── Customers
├── Invoices/Billing
├── Udhar (Credit tracking)
├── Inventory
├── Transactions
└── Analytics Events
```

---

## 🔄 **API ARCHITECTURE**

#### **REST API + WebSocket**
- RESTful for CRUD operations
- WebSocket for real-time updates (inventory, orders)

#### **API Versioning**: `/api/v1/...`
- Future-proof for breaking changes

#### **Rate Limiting**: Redis + Token Bucket
- Protect from abuse
- Different limits per endpoint

#### **Request/Response Format**:
```json
{
  "success": true,
  "data": {...},
  "meta": {
    "timestamp": "2026-05-19T10:00:00Z"
  }
}
```

---

## 🎯 **DEVELOPMENT WORKFLOW**

1. **Local Development**: Docker Compose for MySQL, Redis, Elasticsearch
2. **Version Control**: Git + GitHub
3. **CI/CD**: GitHub Actions
4. **Testing**: Jest (backend) + Vitest (frontend)
5. **Code Quality**: ESLint + Prettier
6. **Type Checking**: TypeScript strict mode

---

## 🚀 **SCALABILITY STRATEGY**

### **Horizontal Scaling**:
- Multiple API instances behind load balancer
- Database read replicas
- Redis cluster for caching
- Elasticsearch cluster for search

### **Vertical Scaling**:
- Database optimization
- Query caching
- CDN for static assets

### **Microservices (Phase 3+)**:
- Separate AI service (FastAPI)
- Separate analytics service
- Event-driven architecture with message queues

---

## ✅ **DECISION SUMMARY TABLE**

| Layer | Technology | Alternative | Why Chosen |
|-------|-----------|-------------|-----------|
| **Frontend** | Next.js | React SPA | SSR, performance, Vercel |
| **Language** | TypeScript | JavaScript | Type safety, maintainability |
| **Styling** | Tailwind CSS | Styled-components | Utility-first, performant |
| **Components** | shadcn/ui | Material-UI | Ownership, customizable |
| **Animation** | Framer Motion | React Spring | Performance, ease of use |
| **Charts** | Recharts | Chart.js | React-native, composable |
| **State** | Zustand | Redux | Minimal, TypeScript-first |
| **Backend** | NestJS | Express | Enterprise structure, DI |
| **Database** | MySQL | PostgreSQL | Proven for retail, PlanetScale |
| **ORM** | Prisma | TypeORM | Type safety, migrations |
| **Search** | MeiliSearch→ES | Algolia | Open-source, cost-effective |
| **Cache** | Redis | Memcached | Pub/Sub, persistence |
| **Real-time** | Socket.IO | GraphQL Subscriptions | Reliability, fallbacks |
| **Auth** | NextAuth.js | Auth0 | Built-in, Next.js native |
| **AI** | FastAPI + OpenAI | LangChain | Speed, flexibility |
| **Deployment** | Vercel + Railway | AWS | Simplicity, auto-scaling |

---

## 🎓 **WHY THIS STACK IS RECRUITER/STARTUP IMPRESSIVE**

✅ **Enterprise-Grade**: Used by unicorn startups
✅ **Scalable**: Handles 100K+ users effortlessly
✅ **Modern**: Latest tech standards (2026)
✅ **Type-Safe**: Full TypeScript stack
✅ **Production-Ready**: Built-in error handling, monitoring
✅ **AI-First**: Native AI integration patterns
✅ **Cloud-Native**: Serverless-ready
✅ **Maintainable**: Clean architecture, modular design
✅ **Performant**: Optimized from ground up
✅ **Developer Experience**: Industry-best DX

---

## 📅 **NEXT STEPS**

**→ PHASE 2**: Move to **UI Implementation** with this tech stack
- Set up Next.js project
- Configure Tailwind + shadcn/ui
- Build dashboard, pages, components
- Implement mock data
- No backend required yet

---

**This tech stack is battle-tested, scalable, and startup-ready.** 🚀
