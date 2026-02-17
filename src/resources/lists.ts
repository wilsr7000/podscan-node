import type { HttpClient } from '../http.js';
import type {
  ListUserListsParams,
  ListUserListsResponse,
  GetListItemsParams,
  GetListItemsResponse,
  AddToListParams,
  AddToListResponse,
} from '../types.js';

export class ListsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Get all lists/collections for your team.
   */
  async list(params?: ListUserListsParams): Promise<ListUserListsResponse> {
    return this.http.get<ListUserListsResponse>('/lists', params);
  }

  /**
   * Get contents of a specific list.
   */
  async getItems(params: GetListItemsParams): Promise<GetListItemsResponse> {
    const { list_id, ...query } = params;
    return this.http.get<GetListItemsResponse>(`/lists/${list_id}/items`, query);
  }

  /**
   * Add items to a list. Accepts mixed item types (podcasts, episodes, entities, topics).
   */
  async addItems(params: AddToListParams): Promise<AddToListResponse> {
    const { list_id, ...body } = params;
    return this.http.post<AddToListResponse>(`/lists/${list_id}/items`, body);
  }
}
