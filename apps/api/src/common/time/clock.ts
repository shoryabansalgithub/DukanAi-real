import { Global, Injectable, Module } from '@nestjs/common';

/**
 * The application clock (roadmap 9.6). Every instant a POS document carries
 * (`createdAt`, the financial-year tag of its number, the business day a
 * cancellation window or a dashboard figure is decided on) is read from here
 * rather than from a bare `new Date()`, so one injectable decides what time
 * it is: production reads the system clock, and the financial-year rollover
 * spec replaces the provider with a settable clock to bill on 31 March 23:59
 * and 1 April 00:01 without waiting for the calendar. Prisma's
 * `@default(now())` is the query engine's own clock and does not go through
 * here, which is why those writers set `createdAt` explicitly from this one.
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}
