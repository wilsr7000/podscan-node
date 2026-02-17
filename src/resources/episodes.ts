import type { HttpClient } from '../http.js';
import { Paginator } from '../paginator.js';
import type {
  Episode,
  SearchEpisodesParams,
  SearchEpisodesResponse,
  GetEpisodeParams,
  GetEpisodeResponse,
  GetRecentEpisodesParams,
  GetRecentEpisodesResponse,
  GetPodcastEpisodesParams,
  GetPodcastEpisodesResponse,
} from '../types.js';

export class EpisodesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Full-text search across podcast episode transcripts, titles, and descriptions.
   */
  async search(params: SearchEpisodesParams): Promise<SearchEpisodesResponse> {
    return this.http.get<SearchEpisodesResponse>('/episodes/search', params);
  }

  /**
   * Auto-paginating search that yields every matching episode across all pages.
   *
   * ```ts
   * for await (const episode of client.episodes.searchAll({ query: 'AI', ...periods.thisWeek() })) {
   *   console.log(episode.episode_title);
   * }
   * ```
   */
  searchAll(params: Omit<SearchEpisodesParams, 'page'>): Paginator<Episode> {
    return new Paginator(async (page) => {
      const res = await this.search({ ...params, page });
      return { items: res.episodes, pagination: res.pagination };
    });
  }

  /**
   * Get detailed information about a specific episode.
   */
  async get(params: GetEpisodeParams): Promise<GetEpisodeResponse> {
    const { episode_id, ...query } = params;
    return this.http.get<GetEpisodeResponse>(`/episodes/${episode_id}`, query);
  }

  /**
   * Get the most recently published podcast episodes.
   */
  async getRecent(params?: GetRecentEpisodesParams): Promise<GetRecentEpisodesResponse> {
    return this.http.get<GetRecentEpisodesResponse>('/episodes/recent', params);
  }

  /**
   * List all episodes for a specific podcast.
   */
  async getByPodcast(params: GetPodcastEpisodesParams): Promise<GetPodcastEpisodesResponse> {
    const { podcast_id, ...query } = params;
    return this.http.get<GetPodcastEpisodesResponse>(`/podcasts/${podcast_id}/episodes`, query);
  }

  /**
   * Auto-paginating version of `getByPodcast()` that yields every episode.
   *
   * ```ts
   * for await (const ep of client.episodes.getByPodcastAll({
   *   podcast_id: 'pd_abc',
   *   ...periods.thisMonth(),
   * })) {
   *   console.log(ep.episode_title);
   * }
   * ```
   */
  getByPodcastAll(params: Omit<GetPodcastEpisodesParams, 'page'>): Paginator<Episode> {
    return new Paginator(async (page) => {
      const res = await this.getByPodcast({ ...params, page });
      return { items: res.episodes, pagination: res.pagination };
    });
  }
}
