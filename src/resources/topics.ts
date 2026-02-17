import type { HttpClient } from '../http.js';
import type {
  SearchTopicsParams,
  SearchTopicsResponse,
  GetTopicParams,
  GetTopicResponse,
  GetTopicEpisodesParams,
  GetTopicEpisodesResponse,
  GetTrendingTopicsParams,
  GetTrendingTopicsResponse,
} from '../types.js';

export class TopicsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Discover topics and subjects discussed across podcasts.
   */
  async search(params: SearchTopicsParams): Promise<SearchTopicsResponse> {
    return this.http.get<SearchTopicsResponse>('/topics/search', params);
  }

  /**
   * Get detailed information about a specific topic.
   */
  async get(params: GetTopicParams): Promise<GetTopicResponse> {
    const { topic_id, ...query } = params;
    return this.http.get<GetTopicResponse>(`/topics/${topic_id}`, query);
  }

  /**
   * Get episodes where a specific topic was mentioned.
   */
  async getEpisodes(params: GetTopicEpisodesParams): Promise<GetTopicEpisodesResponse> {
    const { topic_id, ...query } = params;
    return this.http.get<GetTopicEpisodesResponse>(`/topics/${topic_id}/episodes`, query);
  }

  /**
   * Get currently trending topics across podcasts.
   */
  async getTrending(params?: GetTrendingTopicsParams): Promise<GetTrendingTopicsResponse> {
    return this.http.get<GetTrendingTopicsResponse>('/topics/trending', params);
  }
}
