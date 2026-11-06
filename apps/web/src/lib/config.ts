import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { setTimezone } from './format';

export interface PublicConfig {
  appName: string;
  passwordResetUrl: string;
  tier: 'hipaa' | 'standard';
  timezone: string;
}

export const useConfig = () =>
  useQuery({
    queryKey: ['config'],
    queryFn: async () => {
      const c = await api<PublicConfig>('/config');
      setTimezone(c.timezone);
      return c;
    },
    staleTime: Infinity,
  });
