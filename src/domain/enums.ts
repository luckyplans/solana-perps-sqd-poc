export enum Platform {
  GMTRADE = 'GMTRADE',
  JUPITER = 'JUPITER',
}

export enum PerpTradeHistoryOperation {
  OPEN = 'open',
  CLOSE = 'close',
  INCREASE_SIZE = 'increaseSize',
  DECREASE_SIZE = 'decreaseSize',
  INCREASE_LEVERAGE = 'increaseLeverage',
  DECREASE_LEVERAGE = 'decreaseLeverage',
  PNL_WITHDRAW = 'pnlWithdraw',
}

export enum PerpCloseReason {
  USER = 'user',
  LIQUIDATION = 'liquidation',
  ADL = 'adl',
  TAKE_PROFIT = 'takeProfit',
  STOP_LOSS = 'stopLoss',
  UNKNOWN = 'unknown',
}

export enum DataQuality {
  COMPLETE = 'complete',
  PARTIAL_MARKET = 'partialMarket',
  PARTIAL_COLLATERAL = 'partialCollateral',
  PARTIAL_STATE = 'partialState',
}

export enum IngestionSource {
  SQD = 'sqd',
  DUNE = 'dune',
  JSONL = 'jsonl',
}
