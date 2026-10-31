import { Button } from "@example/ui";
import { App } from "./app.js";

export function render() {
  return <App action={<Button label="Go" />} />;
}
