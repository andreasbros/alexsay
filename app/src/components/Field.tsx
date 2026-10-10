import { Text, TextField } from "@radix-ui/themes";
import type { ComponentProps } from "react";

type Props = { id: string; label: string } & ComponentProps<typeof TextField.Root>;

/** A labelled text input; the label text is what tests and screen readers find it by. */
export function Field({ id, label, ...input }: Props) {
  return (
    <label htmlFor={id}>
      <Text size="2" weight="medium">
        {label}
      </Text>
      <TextField.Root id={id} mt="1" {...input} />
    </label>
  );
}
