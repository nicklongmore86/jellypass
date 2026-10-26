// The title pages' routes, the same under each tab that opens titles (src/app/(tabs)/<tab>/movie/[id].tsx and the
// rest): the address's numbers, checked, or Not found without a call.
import { useLocalSearchParams } from 'expo-router';

import type { TitleTab } from '../navigation/titles';
import { routeNumber } from '../title/route';
import { NotFoundScreen } from './NotFoundScreen';
import { TitleScreen } from './TitleScreen';

export function MovieRoute({ tab }: { tab: TitleTab }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tmdbId = routeNumber(id);
  return tmdbId === undefined ? <NotFoundScreen /> : <TitleScreen key={tmdbId} tab={tab} route={{ mediaType: 'movie', tmdbId }} />;
}

export function SeriesRoute({ tab }: { tab: TitleTab }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tmdbId = routeNumber(id);
  return tmdbId === undefined ? <NotFoundScreen /> : <TitleScreen key={tmdbId} tab={tab} route={{ mediaType: 'tv', tmdbId }} />;
}

export function SeasonRoute({ tab }: { tab: TitleTab }) {
  const { id, season } = useLocalSearchParams<{ id: string; season: string }>();
  const tmdbId = routeNumber(id);
  const seasonNumber = routeNumber(season, 0);
  if (tmdbId === undefined || seasonNumber === undefined) return <NotFoundScreen />;
  return <TitleScreen key={`${tmdbId}-${seasonNumber}`} tab={tab} route={{ mediaType: 'season', tmdbId, seasonNumber }} />;
}
