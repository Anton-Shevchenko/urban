import { useContext } from 'react';
import { ChatContext, requireWohnIndexCtx, type ChatSlice } from '../contexts';

export type { ChatSlice };

export function useChat(): ChatSlice {
  return requireWohnIndexCtx(useContext(ChatContext), 'useChat');
}
