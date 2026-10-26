// Search and My requests until their screens come (3.4 to 3.6): the route, title and tab are final, the content
// is one line saying what is coming.
import { Body, Card, Screen } from '../ui';

export const PLACEHOLDER_TEXT = {
  search: 'Searching for films and series comes in the next version of the app.',
  requests: "What you and your household have asked for comes in the next version of the app.",
} as const;

export function PlaceholderScreen({ text }: { text: string }) {
  return (
    <Screen>
      <Card>
        <Body>{text}</Body>
      </Card>
    </Screen>
  );
}
