import type { HttpClient } from '../http.js';
import { Paginator } from '../paginator.js';
import type {
  Podcast,
  SearchPodcastsParams,
  SearchPodcastsResponse,
  GetPodcastParams,
  GetPodcastResponse,
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
   * Auto-paginating search that yields every matching podcast across all pages.
   */
  searchAll(params: Omit<SearchPodcastsParams, 'page'>): Paginator<Podcast> {
    return new Paginator(async (page) => {
      const res = await this.search({ ...params, page });
      return { items: res.podcasts, pagination: res.pagination };
    });
  }

  /**
   * Get detailed information about a specific podcast.
   */
  async get(params: GetPodcastParams): Promise<GetPodcastResponse> {
    const { podcast_id, ...query } = params;
    return this.http.get<GetPodcastResponse>(`/podcasts/${podcast_id}`, query);
  }
}
