/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Server URL - Public base URL of the hosted Project Planner app */
  "serverUrl": string,
  /** Username - Shared login username for Project Planner */
  "username": string,
  /** Password - Shared login password for Project Planner */
  "password": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `add-task` command */
  export type AddTask = ExtensionPreferences & {}
  /** Preferences accessible in the `list-available-tasks` command */
  export type ListAvailableTasks = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `add-task` command */
  export type AddTask = {}
  /** Arguments passed to the `list-available-tasks` command */
  export type ListAvailableTasks = {}
}

