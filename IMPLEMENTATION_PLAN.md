> **Historical document, superseded.** Kept for the record: it describes an
> earlier state of the project (mock data, Next.js 14, Node 18/20, features
> that were never built) and is no longer maintained. Current documentation:
> [README.md](./README.md) (what is built, how to run it, the docs map),
> [AGENTS.md](./AGENTS.md) (architecture and sharp edges) and
> [docs/](./docs) (deployment, operations, release, go-live).

# DukaanAI - Comprehensive Feature Implementation Plan

## 🎯 Overview
This document outlines the detailed working plan and roadmap for implementing all remaining features for DukaanAI, spanning across Backend & Core Functionality (Phase 3), AI Features (Phase 4), and Production Optimization (Phase 5). This plan integrates necessary architectural fixes and feature rollouts sequentially to ensure a stable and scalable application.

---

## 🛠️ Phase 3: Backend Stabilization & Core Functionality

### 3.1 Backend Stabilization & Critical Fixes (Pre-requisites)
Before implementing new business logic, the existing backend foundation must be stabilized based on the system analysis report.

- **Dependency & Build Fixes**:
  - Install missing dependencies: `@types/uuid` and `axios`.
- **Runtime Stability (P0)**:
  - Fix Prisma `findUnique` calls on non-unique fields (e.g., `isDeleted` in `users.service.ts`) by converting them to `findFirst`.
  - Fix the `PrismaService` proxy pattern to prevent split-brain client instance issues between lifecycle hooks and queries.
  - Deduplicate `ScheduleModule.forRoot()` by removing it from `OutboxModule` and `ProductEventsModule`, keeping it only in `AppModule`.
- **Architectural Consolidation (P1)**:
  - Unify the three redundant event/outbox systems (`common/outbox`, `product-events`, `events-domain`) into a single relay to prevent race conditions.
  - Audit database schema: Update `onDelete: NoAction` to `Cascade` or `Restrict` where appropriate. Add composite indexes for soft-deleted tables (`isDeleted`, `deletedAt`).

### 3.2 Authentication, Authorization & Security
- **JWT & NextAuth.js**: Set up robust authentication strategies.
- **RBAC (Role-Based Access Control)**: Implement robust roles (Admin, Manager, Cashier) with strict endpoint guards.
- **Security Hardening**: Configure CORS, rate limiting, and custom Helmet CSP/HSTS policies.

### 3.3 Core Business Modules Implementation
- **Billing (POS System)**:
  - **Smart Search**: Integrate fuzzy searching (Elasticsearch/MeiliSearch) with barcode scanning support.
  - **Cart & Payments**: Implement cart logic (taxes, discounts), multi-payment support (Cash, UPI, Card, Udhar), and split payments.
  - **Invoicing**: Automatic invoice generation, PDF exports, and email receipts.
- **Customers & Udhar Management**:
  - **Credit Tracking**: Robust ledger for Udhar tracking, payment history, and overdue alerting.
  - **Communication**: Setup WhatsApp API / SMS integrations for payment reminders.
- **Inventory Management**:
  - **Stock Tracking**: Real-time deduction on billing, manual adjustments, and multi-shop transfers.
  - **Alerts & Lifecycles**: Low-stock automated alerts, batch number tracking, and expiry date management.
- **Analytics & Reporting**:
  - Build endpoints for Sales, Customers, and Product performance aggregations.
  - Implement time-series data endpoints for dashboard charts.

### 3.4 Real-time Synchronization
- **Socket.IO Setup**: Authenticated WebSockets for live updates across terminals.
- **Live Events**: Real-time inventory deduction sync and instant order notifications.

---

## 🤖 Phase 4: AI Features Implementation

### 4.1 AI Service Infrastructure
- **FastAPI Microservice**: Stand up a Python-based FastAPI service dedicated to ML/AI workloads.
- **Integrations**: Set up OpenAI API, LangChain, and Deepgram (Speech-to-text).

### 4.2 AI Capabilities Rollout
- **Conversational AI Assistant**:
  - Natural language querying of business data (e.g., "What are my top-selling items today?").
  - Smart recommendations for pricing and customer engagement.
- **Voice Billing System**:
  - Implement Deepgram-powered speech-to-text for hands-free POS operation (e.g., "Add two Maggi").
  - Text-to-speech confirmation functionality.
- **OCR Invoice Scanner**:
  - Tesseract/Paddle OCR integration to scan and parse supplier invoices automatically.
- **Predictive Analytics**:
  - Implement forecasting models (e.g., Prophet) for inventory demand and sales trend prediction.

### 4.3 Frontend Integration
- Build conversational UI interfaces in the Next.js app.
- Implement microphone access and voice wave visualizations.
- Implement drag-and-drop zones for OCR invoice uploads.

---

## 🚀 Phase 5: Production Optimization & Deployment

### 5.1 Performance Tuning
- **Caching**: Implement robust Redis caching for frequently accessed data (e.g., product catalog, dashboard stats).
- **Database Optimization**: Final query optimization pass, ensuring lazy loading and optimized index utilization.
- **Frontend Optimization**: Code splitting, dynamic imports, and aggressive image optimization.

### 5.2 Deployment Architecture
- **Containerization**: Create optimized Dockerfiles and Docker Compose configurations for the API, Web app, and AI Microservice.
- **CI/CD Pipelines**: Set up GitHub Actions for automated testing, linting, and deployment.
- **Environment Management**: Implement secure secrets management for production.

### 5.3 Observability
- **Monitoring**: Deploy Prometheus and Grafana for system metrics.
- **Error Tracking**: Integrate Sentry for real-time error reporting across frontend and backend.
- **Logging**: Set up centralized application logging.

---

## 📋 Implementation Tracking Guidelines
- **No Code Changes in this plan**: This file serves purely as the architectural roadmap and task tracker for the repository.
- **Iterative Merging**: Each sub-section should ideally represent a distinct branch and PR.
- **Testing Requirements**: Unit, integration, and E2E tests must be written alongside feature implementation, not deferred.

**Status**: Ready for Execution.
