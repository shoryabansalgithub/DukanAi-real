import { Injectable } from '@nestjs/common';

@Injectable()
export class AnalyticsForecastingService {
  async prepareForecasts(_shopId: string) {
    // Stub for future AI integration (Phase 4)
    return true;
  }
}
