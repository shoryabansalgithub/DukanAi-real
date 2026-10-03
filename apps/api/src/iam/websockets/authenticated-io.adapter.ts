import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../../config/domains/app.config';
import { JWT_ALGORITHM, JwtConfig } from '../../config/domains/jwt.config';
import { PrismaService } from '../../prisma/prisma.service';
import { SocketSessionService } from './socket-session.service';
import { CORRELATION_HEADER, sanitizeIdentifier } from '../../common/correlation/correlation-id';

export class AuthenticatedIoAdapter extends IoAdapter {
  // `IoAdapter` declares a protected `logger` since @nestjs/platform-socket.io 11.2: override it with our own tag.
  protected override readonly logger = new Logger(AuthenticatedIoAdapter.name);
  private readonly jwtService: JwtService;
  private readonly appConfig: AppConfig;
  private readonly jwtConfig: JwtConfig;
  private readonly prisma: PrismaService;
  private readonly sessionService: SocketSessionService;

  constructor(private app: INestApplicationContext) {
    super(app);
    this.jwtService = app.get(JwtService);
    this.appConfig = app.get(AppConfig);
    this.jwtConfig = app.get(JwtConfig);
    this.prisma = app.get(PrismaService);
    this.sessionService = app.get(SocketSessionService);
  }

  createIOServer(port: number, options?: any): Server {
    const frontendUrl = this.appConfig.frontendUrl;
    const origins = frontendUrl.split(',').map((s: string) => s.trim());
    
    options = {
      ...options,
      cors: {
        origin: origins,
        credentials: true,
      }
    };
    const server: Server = super.createIOServer(port, options);

    // `server.use` only guards the root namespace; gateways such as /inventory
    // are namespaces of their own, created after this point. Register the
    // middleware on the root and on every namespace as it appears (P2-17).
    server.use(this.authenticate);
    server.on('new_namespace', (namespace) => namespace.use(this.authenticate));

    return server;
  }

  /** Verifies the token, checks the user, session family and shop, then joins the tenant room. */
  private readonly authenticate = async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
    {
      try {
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.replace('Bearer ', '');

        if (!token) {
          this.logger.warn(`Connection rejected: Missing token`);
          return next(new Error('Authentication Error: Missing token'));
        }

        // Verify JWT Signature
        const payload = this.jwtService.verify(token, {
          secret: this.jwtConfig.jwtSecret,
          algorithms: [JWT_ALGORITHM],
        });

        if (!payload || !payload.sub || !payload.shopId || typeof payload.sid !== 'string') {
          this.logger.warn(`Connection rejected: Invalid token payload`);
          return next(new Error('Authentication Error: Invalid token'));
        }

        const userId = payload.sub;
        const shopId = payload.shopId;
        const tokenVersion = payload.tokenVersion;

        // Perform Zero Trust check against Database
        const now = new Date();
        const user = await this.prisma.user.findUnique({
          where: { id: userId, isDeleted: false },
          select: {
            isActive: true,
            tokenVersion: true,
            role: true,
            // The session family behind the token must still be live (logout, revoke, reuse, absolute lifetime).
            refreshTokens: { where: { familyId: payload.sid, isRevoked: false, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } }, select: { id: true }, take: 1 },
          },
        });

        if (!user) {
          return next(new Error('Authentication Error: User not found or deleted'));
        }
        // A brute-force lock blocks new logins only; it does not drop live sockets (P1-4).
        if (!user.isActive || user.refreshTokens.length === 0) {
          return next(new Error('Authentication Error: Account suspended or locked'));
        }
        if (user.tokenVersion !== tokenVersion) {
          return next(new Error('Authentication Error: Session revoked'));
        }

        const shop = await this.prisma.shop.findUnique({
          where: { id: shopId },
          select: { status: true, isDeleted: true },
        });

        if (!shop || shop.isDeleted) {
          return next(new Error('Authentication Error: Shop deleted'));
        }
        if (shop.status !== 'ACTIVE') {
          return next(new Error('Authentication Error: Shop suspended'));
        }

        // Safely attach ambient context properties to socket.data
        // These are guaranteed cryptographically & verified against DB
        socket.data.userId = userId;
        socket.data.shopId = shopId;
        socket.data.role = user.role;
        socket.data.correlationId = sanitizeIdentifier(socket.handshake.headers[CORRELATION_HEADER]);
        
        // Register connection for session revocation
        this.sessionService.registerSocket(userId, socket);

        // Force deterministic room joins based solely on validated server context
        void socket.join(`tenant:${shopId}`);
        
        next();
      } catch (error: any) {
        this.logger.warn(`Connection rejected: ${error.message}`);
        next(new Error('Authentication Error: Unauthorized'));
      }
    }
  };
}
