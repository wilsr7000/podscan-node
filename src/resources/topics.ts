import type { HttpClient } from '../http.js';
import { Paginator } from '../paginator.js';
import type {
  Episode,
  TopicSummary,
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
   * Auto-paginating search that yields every matching topic across all pages.
   */
  searchAll(params: Omit<SearchTopicsParams, 'page'>): Paginator<TopicSummary> {
    return new Paginator(async (page) => {
      const res = await this.search({ ...params, page });
      return { items: res.topics, pagination: res.pagination };
    });
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
   * Auto-paginating version of `getEpisodes()` that yields every episode for a topic.
   */
  getEpisodesAll(params: Omit<GetTopicEpisodesParams, 'page'>): Paginator<Episode> {
    return new Paginator(async (page) => {
      const res = await this.getEpisodes({ ...params, page });
      return { items: res.episodes, pagination: res.pagination };
    });
  }

  /**
   * Get currently trending topics across podcasts.
   */
  async getTrending(params?: GetTrendingTopicsParams): Promise<GetTrendingTopicsResponse> {
    return this.http.get<GetTrendingTopicsResponse>('/topics/trending', params);
  }
}
