# Etapa 1: Construcción
FROM node:22-alpine AS build

WORKDIR /app

# Habilitar corepack para usar pnpm de forma nativa
RUN corepack enable && corepack prepare pnpm@latest --activate

# Desactivar verificación de antigüedad de publicación de paquetes
RUN pnpm config set minimum-release-age 0

# Copiar archivos de dependencias
COPY package.json pnpm-lock.yaml ./

# Instalar dependencias con congelación de versión
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copiar el resto del código fuente
COPY . .

# Compilar la aplicación web
RUN pnpm run build

# Etapa 2: Servidor Web de Producción
FROM nginx:alpine

# Copiar la plantilla de configuración de Nginx para soportar puerto dinámico
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Copiar la compilación estática al directorio de nginx
COPY --from=build /app/dist /usr/share/nginx/html

# Exponer los puertos posibles
EXPOSE 80 3000

CMD ["nginx", "-g", "daemon off;"]
