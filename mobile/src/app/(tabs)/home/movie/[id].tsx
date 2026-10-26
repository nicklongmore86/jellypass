import { useLocalSearchParams } from 'expo-router';

import { NotFoundScreen } from '@/screens/NotFoundScreen';
import { TitleScreen } from '@/screens/TitleScreen';
import { routeNumber } from '@/title/route';

export default function MovieTitle() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tmdbId = routeNumber(id);
  return tmdbId === undefined ? <NotFoundScreen /> : <TitleScreen key={tmdbId} route={{ mediaType: 'movie', tmdbId }} />;
}
