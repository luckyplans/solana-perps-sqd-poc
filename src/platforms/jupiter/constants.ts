import { anchorEventDiscriminatorHex } from '../../codec/anchor';
export const JUPITER_PROGRAM_ID = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';
export const JUPITER_USD_DECIMALS = 6;
export const JUPITER_EVENTS = {
  IncreasePositionEvent: anchorEventDiscriminatorHex('IncreasePositionEvent'),
  DecreasePositionEvent: anchorEventDiscriminatorHex('DecreasePositionEvent'),
  LiquidatePositionEvent: anchorEventDiscriminatorHex('LiquidatePositionEvent'),
  LiquidateFullPositionEvent: anchorEventDiscriminatorHex('LiquidateFullPositionEvent'),
  InstantIncreasePositionEvent: anchorEventDiscriminatorHex('InstantIncreasePositionEvent'),
  InstantDecreasePositionEvent: anchorEventDiscriminatorHex('InstantDecreasePositionEvent'),
  DepositCollateralEvent: anchorEventDiscriminatorHex('DepositCollateralEvent'),
  WithdrawCollateralEvent: anchorEventDiscriminatorHex('WithdrawCollateralEvent'),
} as const;
