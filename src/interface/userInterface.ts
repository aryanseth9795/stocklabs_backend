/**
 * Body of a trade request.
 *
 * `userId` is deliberately absent: the account is taken from the authenticated
 * session, never from the request body (S-03).
 *
 * `rate` is deliberately absent: the fill price is the server's live price,
 * never the client's (S-02). Clients may still send one; it is ignored.
 */
export interface TradeRequestBody {
  stockName: string;
  quantity: number;
  type: "buy" | "sell";
}