// Single icon registry for the app. Geist icons only (see AGENTS.md): these are
// Vercel's actual glyphs, 1em / currentColor, sized by surrounding font.
import {
  ArrowLeft, ChevronDownSmall, ChevronRight, MagnifyingGlass, Calendar,
  Clock, ClockDashed, Globe, Lightning, Terminal, Message,
  Wrench, Coins, Copy, External,
  Plus, Play, StopCircle, FolderClosed, LoaderCircle,
} from "vercel-geist-icons";

export const I = {
  back: <ArrowLeft />,
  chevDown: <ChevronDownSmall />,
  chevRight: <ChevronRight />,
  search: <MagnifyingGlass />,
  calendar: <Calendar />,
  clock: <Clock />,           // plain ring — turn stat bars
  clockDashed: <ClockDashed />, // dashed — table trigger cells
  globe: <Globe />,
  bolt: <Lightning />,
  terminal: <Terminal />,
  message: <Message />,
  wrench: <Wrench />,
  coins: <Coins />,
  copy: <Copy />,
  external: <External />,
  plus: <Plus />,
  play: <Play />,
  stop: <StopCircle />,
  folder: <FolderClosed />,
  loader: <LoaderCircle />,
};

export const triggerIcon = (t) =>
  t === "schedule" ? I.clockDashed : t === "http" ? I.globe : (t ?? "").startsWith("channel") ? I.message : I.bolt;
