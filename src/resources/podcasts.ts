import type { HttpClient } from '../http.js';
import type {
  SearchPodcastsParams,
  SearchPodcastsResponse,
  GetPodcastParams,
  GetPodcastResponse,
  GetSimilarPodcastsParams,
  GetSimilarPodcastsResponse,
  GetPodcastReviewsParams,
  GetPodcastReviewsResponse,
  GetPodcastDemographicsParams,
  GetPodcastDemographicsResponse,
} from '../types.js';

export class PodcastsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Search podcasts by name, topic, or characteristics.
   */
  async search(params: SearchPodcastsParams): Promise<SearchPodcastsResponse> {
    return this.http.get<SearchPodcastsResponse>('/podcasts/search', params);
  }

  /**
   * Get detailed information about a specific podcast.
   */
  async get(params: GetPodcastParams): Promise<GetPodcastResponse> {
    const { podcast_id, ...query } = params;
    return this.http.get<GetPodcastResponse>(`/podcasts/${podcast_id}`, query);
  }

  /**
   * Find podcasts similar to a given podcast.
   */
  async getSimilar(params: GetSimilarPodcastsParams): Promise<GetSimilarPodcastsResponse> {
    const { podcast_id, ...query } = params;
    return this.http.get<GetSimilarPodcastsResponse>(`/podcasts/${podcast_id}/similar`, query);
  }

  /**
   * Get aggregated review and rating data for a podcast.
   */
  async getReviews(params: GetPodcastReviewsParams): Promise<GetPodcastReviewsResponse> {
    const { podcast_id } = params;
    return this.http.get<GetPodcastReviewsResponse>(`/podcasts/${podcast_id}/reviews`);
  }

  /**
   * Search podcasts by audience demographic criteria.
   */
  async getDemographics(
    params?: GetPodcastDemographicsParams,
  ): Promise<GetPodcastDemographicsResponse> {
    return this.http.get<GetPodcastDemographicsResponse>('/podcasts/demographics', params);
  }
}
