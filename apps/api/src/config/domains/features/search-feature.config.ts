import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, Min } from 'class-validator';
import { IntegerFromEnv } from '../../hydrate-from-env';

/**
 * Product search sizes. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Search', feature: 'Product Search Domain', version: '1.1.0', description: 'Configuration for Product Search Features' })
export class SearchFeatureConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('SEARCH_FUZZY_CANDIDATE_LIMIT')
  fuzzyCandidateLimit: number = 100;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('SEARCH_RESULT_LIMIT')
  searchResultLimit: number = 5;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('SEARCH_ANALYTICS_LIMIT')
  analyticsLimit: number = 10;

  /** SearchHistory rows one shop may write per minute (roadmap 5.3); searches beyond it are served but not recorded. */
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('SEARCH_HISTORY_MAX_PER_MINUTE')
  historyMaxPerMinute: number = 120;
}
