import { beforeEach, describe, expect, it } from "vitest";
import { lightWrites } from "../src/tools";
import { APP, addUser, call, connectLightwave, json, mockUpstream, reply, resetDb, signIn } from "./helpers";

const STRUCTURE = {
  structureId: "s1",
  name: "Home",
  devices: [
    {
      deviceId: "d1",
      name: "Kitchen dimmer",
      featureSets: [
        {
          featureSetId: "fs1",
          name: "Kitchen",
          features: [
            { featureId: "f-switch", type: "switch", writable: true },
            { featureId: "f-dim", type: "dimLevel", writable: true },
          ],
        },
      ],
    },
    {
      deviceId: "d2",
      name: "Sensor",
      featureSets: [
        {
          featureSetId: "fs2",
          name: "Hall",
          features: [{ featureId: "f-temp", type: "temperature", writable: false }],
        },
      ],
    },
  ],
};

describe("lightwave", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
  });

  it("needs a Lightwave connection", async () => {
    expect((await call(`${APP}/api/lightwave/lights`, {}, maria)).status).toBe(412);
  });

  it("lists switchable feature sets with their live state", async () => {
    await connectLightwave(maria);
    const upstream = mockUpstream({
      "GET https://publicapi.lightwaverf.com/v1/structures": () => reply(200, { structures: ["s1"] }),
      "GET https://publicapi.lightwaverf.com/v1/structure/s1": () => reply(200, STRUCTURE),
      "POST https://publicapi.lightwaverf.com/v1/features/read": (_req, body) => {
        expect(JSON.parse(body)).toEqual({ features: [{ featureId: "f-switch" }, { featureId: "f-dim" }] });
        return reply(200, { "f-switch": 1, "f-dim": 40 });
      },
    });
    const res = await call(`${APP}/api/lightwave/lights`, {}, maria);
    upstream.done();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: "fs1",
        name: "Kitchen",
        device: "Kitchen dimmer",
        switch: "f-switch",
        dim: "f-dim",
        on: true,
        dim_level: 40,
      },
    ]);
  });

  it("writes a feature value", async () => {
    await connectLightwave(maria);
    const upstream = mockUpstream({
      "POST https://publicapi.lightwaverf.com/v1/feature/f-switch": (_req, body) => {
        expect(body).toBe('{"value":0}');
        return reply(200, {});
      },
    });
    const res = await json(`${APP}/api/lightwave/features/f-switch`, "POST", { value: 0 }, maria);
    upstream.done();
    expect(res.status).toBe(204);
    expect((await json(`${APP}/api/lightwave/features/f-switch`, "POST", { value: 101 }, maria)).status).toBe(400);
  });

  it("writes several features in one Lightwave call", async () => {
    await connectLightwave(maria);
    const upstream = mockUpstream({
      "POST https://publicapi.lightwaverf.com/v1/features/write": (_req, body) => {
        expect(JSON.parse(body)).toEqual({
          features: [
            { featureId: "f-switch", value: 1 },
            { featureId: "f-dim", value: 60 },
          ],
        });
        return reply(200, {});
      },
    });
    const res = await json(
      `${APP}/api/lightwave/features`,
      "POST",
      {
        features: [
          { featureId: "f-switch", value: 1 },
          { featureId: "f-dim", value: 60 },
        ],
      },
      maria,
    );
    upstream.done();
    expect(res.status).toBe(204);
    expect((await json(`${APP}/api/lightwave/features`, "POST", { features: [] }, maria)).status).toBe(400);
  });

  it("accepts Lightwave's real feature id shape, plus sign included", async () => {
    await connectLightwave(maria);
    const id = "5b8aa9b4d36c330fd5b4e100-22-3157332334+1";
    const upstream = mockUpstream({
      [`POST https://publicapi.lightwaverf.com/v1/feature/${id}`]: (_req, body) => {
        expect(body).toBe('{"value":1}');
        return reply(200, {});
      },
    });
    const res = await json(`${APP}/api/lightwave/features/${encodeURIComponent(id)}`, "POST", { value: 1 }, maria);
    upstream.done();
    expect(res.status).toBe(204);
  });

  it("never writes a dim level when switching off, and never below 1%", () => {
    const dimmable = { id: "fs1", name: "Kitchen", device: "d", switch: "sw", dim: "dm", on: true, dim_level: 60 };
    expect(lightWrites([dimmable], { on: false, dim_level: 0 })).toEqual([{ featureId: "sw", value: 0 }]);
    expect(lightWrites([dimmable], { on: false })).toEqual([{ featureId: "sw", value: 0 }]);
    expect(lightWrites([dimmable], { dim_level: 0 })).toEqual([{ featureId: "dm", value: 1 }]);
    expect(lightWrites([dimmable], { on: true, dim_level: 40 })).toEqual([
      { featureId: "dm", value: 40 },
      { featureId: "sw", value: 1 },
    ]);
    expect(lightWrites([dimmable], { on: true })).toEqual([{ featureId: "sw", value: 1 }]);
  });
});
