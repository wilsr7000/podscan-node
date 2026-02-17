import type { HttpClient } from '../http.js';
import { Paginator } from '../paginator.js';
import type {
  Entity,
  SearchEntitiesParams,
  SearchEntitiesResponse,
  GetEntityParams,
  GetEntityResponse,
  GetEntityAppearancesParams,
  GetEntityAppearancesResponse,
} from '../types.js';

export class EntitiesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Search for people and organizations mentioned across podcasts.
   */
  async search(params: SearchEntitiesParams): Promise<SearchEntitiesResponse> {
    return this.http.get<SearchEntitiesResponse>('/entities/search', params);
  }

  /**
   * Auto-paginating search that yields every matching entity across all pages.
   */
  searchAll(params: Omit<SearchEntitiesParams, 'page'>): Paginator<Entity> {
    return new Paginator(async (page) => {
      const res = await this.search({ ...params, page });
      return { items: res.entities, pagination: res.pagination };
    });
  }

  /**
   * Get detailed information about a person or organization.
   */
  async get(params: GetEntityParams): Promise<GetEntityResponse> {
    const { entity_id, ...query } = params;
    return this.http.get<GetEntityResponse>(`/entities/${entity_id}`, query);
  }

  /**
   * Get all podcast appearances for a specific entity.
   */
  async getAppearances(params: GetEntityAppearancesParams): Promise<GetEntityAppearancesResponse> {
    const { entity_id, ...query } = params;
    return this.http.get<GetEntityAppearancesResponse>(`/entities/${entity_id}/appearances`, query);
  }
}
