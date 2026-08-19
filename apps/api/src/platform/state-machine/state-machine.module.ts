import { Module } from "@nestjs/common";
import { StateMachineService } from "./state-machine.service";

@Module({ providers: [StateMachineService], exports: [StateMachineService] })
export class StateMachineModule {}
