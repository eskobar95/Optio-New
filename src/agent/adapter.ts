/**
 * Swappable model boundary for the request-response agent loop.
 * Callers inject an implementation; the loop does not open a network connection.
 */

export interface ModelRequest {
  prompt: string;
}

export interface ModelResponse {
  text: string;
}

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
