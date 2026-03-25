import { createLibrary } from "@openuidev/react-lang";
import { ALL_COMPONENTS, PROMPT_OPTIONS } from "./schemas";

const chatLibrary = createLibrary({
  root: "ResponseCard",
  components: ALL_COMPONENTS,
});

export const OPENUI_SYSTEM_PROMPT = chatLibrary.prompt(PROMPT_OPTIONS);
