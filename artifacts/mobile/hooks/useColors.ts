import { useColorScheme } from "react-native";

import colors from "@/constants/colors";

export function useColors() {
  const scheme = useColorScheme();
  const hasKey = (key: string): key is keyof typeof colors =>
    key in colors;
  const palette =
    scheme === "dark" && hasKey("dark")
      ? colors.dark
      : colors.light;
  return { ...palette, radius: colors.radius };
}
