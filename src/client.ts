import { HttpClient } from './http.js';
import { EpisodesResource } from './resources/episodes.js';
import { PodcastsResource } from './resources/podcasts.js';
import { AlertsResource } from './resources/alerts.js';
import { TopicsResource } from './resources/topics.js';
import { EntitiesResource } from './resources/entities.js';
import { ListsResource } from './resources/lists.js';
import { ChartsResource } from './resources/charts.js';
import { PublishersResource } from './resources/publishers.js';
import type { RateLimitInfo } from './http.js';

export interface PodscanClientOptions {
  /** Your Podscan API key (Bearer token). */
  apiKey: string;
  /** Override the base URL (default: https://podscan.fm/api/v1). */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeout?: number;
}

export class PodscanClient {
  private readonly http: HttpClient;

  /** Search and retrieve podcast episodes, transcripts, and recent content. */
  readonly episodes: EpisodesResource;
  /** Search and retrieve podcast metadata, reviews, demographics, and similar shows. */
  readonly podcasts: PodcastsResource;
  /** Create and manage keyword monitoring alerts and their mentions. */
  readonly alerts: AlertsResource;
  /** Search, retrieve, and track trending topics across podcasts. */
  readonly topics: TopicsResource;
  /** Search and retrieve people and organizations mentioned in podcasts. */
  readonly entities: EntitiesResource;
  /** Manage curated collections of podcasts, episodes, entities, and topics. */
  readonly lists: ListsResource;
  /** Access Apple Podcasts and Spotify chart rankings. */
  readonly charts: ChartsResource;
  /** Retrieve publisher information and podcast portfolios. */
  readonly publishers: PublishersResource;

  constructor(options: PodscanClientOptions) {
    this.http = new HttpClient(options);

    this.episodes = new EpisodesResource(this.http);
    this.podcasts = new PodcastsResource(this.http);
    this.alerts = new AlertsResource(this.http);
    this.topics = new TopicsResource(this.http);
    this.entities = new EntitiesResource(this.http);
    this.lists = new ListsResource(this.http);
    this.charts = new ChartsResource(this.http);
    this.publishers = new PublishersResource(this.http);
  }

  /** Current rate-limit info from the most recent API response, or null if no request has been made. */
  get rateLimit(): RateLimitInfo | null {
    return this.http.rateLimit;
  }
}
