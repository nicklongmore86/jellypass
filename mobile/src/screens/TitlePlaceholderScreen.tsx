// A movie's or series' page until 3.3 builds it: the route (/home/movie/<id>, /home/tv/<id>), its place on the Home
// tab's stack and Back are final; the content is one line saying what is coming. It makes no call.
import { Stack } from 'expo-router';

import type { MediaType } from '../api/types';
import { Body, Card, Screen } from '../ui';

export const TITLE_PLACEHOLDER_TEXT = 'The full page for this title, with Play and Get this, comes in the next version of the app.';
export const TITLE_HEADER: Record<MediaType, string> = { movie: 'Movie', tv: 'Series' };

export function TitlePlaceholderScreen({ mediaType }: { mediaType: MediaType }) {
  return (
    <Screen>
      <Stack.Screen options={{ title: TITLE_HEADER[mediaType] }} />
      <Card>
        <Body>{TITLE_PLACEHOLDER_TEXT}</Body>
      </Card>
    </Screen>
  );
}
