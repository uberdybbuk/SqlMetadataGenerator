import { createContext } from "react";

// Lets the result grid put a "Hide" button next to Transpose. Outside a query pane there is
// nothing to hide the results in favour of, so the value is null and the button stays away.
export const ResultsToggle = createContext<(() => void) | null>(null);
