import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, IsNumber, IsString, Matches, Max, Min } from 'class-validator';
import { IntegerFromEnv, NumberFromEnv } from '../../hydrate-from-env';

/**
 * OCR matching and timing. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'ocr', feature: 'OcrFeatureConfig', version: '1.2.0', description: 'OCR module parameters' })
export class OcrFeatureConfig {
  /** Gemini model that reads the bill (`generativelanguage.googleapis.com/v1beta/models/<model>`). */
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9.-]{1,80}$/i)
  @EnvVariable('OCR_MODEL')
  model: string = 'gemini-2.0-flash';

  /** Largest image accepted by `POST /ocr/scan-bill` (held in memory and base64-encoded for the model). */
  @IsInt()
  @Min(64 * 1024)
  @Max(50 * 1024 * 1024)
  @IntegerFromEnv()
  @EnvVariable('OCR_MAX_IMAGE_BYTES')
  maxImageBytes: number = 10 * 1024 * 1024;

  /** Line items kept from one document; the rest are dropped before matching. */
  @IsInt()
  @Min(1)
  @Max(500)
  @IntegerFromEnv()
  @EnvVariable('OCR_MAX_ITEMS')
  maxItems: number = 100;

  /** Similarity (0..1) above which an OCR line is matched to a product. */
  @IsNumber()
  @Min(0)
  @Max(1)
  @NumberFromEnv()
  @EnvVariable('OCR_FUZZY_MATCH_THRESHOLD')
  fuzzyMatchThreshold: number = 0.85;

  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('OCR_TIMEOUT_MS')
  timeoutMs: number = 30000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('OCR_BACKOFF_MS')
  backoffMs: number = 1000;

  /**
   * The whole model call, every attempt and backoff included, ends within this
   * budget, below the edge's 60 s upstream timeout (Caddy
   * `EDGE_UPSTREAM_TIMEOUT`, ingress `proxy-read-timeout`): three 30 s attempts
   * used to run 93 s, so the user got the edge's 504 while the API kept
   * calling the model (roadmap 9.19).
   */
  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('OCR_TOTAL_TIMEOUT_MS')
  totalTimeoutMs: number = 50000;
}
