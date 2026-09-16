/** `Response.json()` is typed `unknown` under Node's types; tests want the parsed document. */

export const readJson = async (response: Response): Promise<any> => (await response.json()) as any;
