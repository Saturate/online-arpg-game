/** Wire format boundary. JSON over text frames for now; a msgpack codec would use Uint8Array. */
export interface Codec<Wire extends string | Uint8Array> {
  encode(message: unknown): Wire;
  decode(data: Wire): unknown;
}

export const jsonCodec: Codec<string> = {
  encode(message) {
    return JSON.stringify(message);
  },
  decode(data) {
    return JSON.parse(data);
  },
};
