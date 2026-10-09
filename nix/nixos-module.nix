{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.oms;
in
{
  options.programs.oms = {
    enable = lib.mkEnableOption "OMS coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.oms.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "OMS package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
