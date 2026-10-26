import { useLocalSearchParams } from 'expo-router';

import { NotFoundScreen } from '@/screens/NotFoundScreen';
import { TitleScreen } from '@/screens/TitleScreen';
import { routeNumber } from '@/title/route';

export default function SeasonTitle() {
  const { id, season } = useLocalSearchParams<{ id: string; season: string }>();
  const tmdbId = routeNumber(id);
  const seasonNumber = routeNumber(season, 0);
  if (tmdbId === undefined || seasonNumber === undefined) return <NotFoundScreen />;
  return <TitleScreen key={`${tmdbId}-${seasonNumber}`} route={{ mediaType: 'season', tmdbId, seasonNumber }} />;
}
