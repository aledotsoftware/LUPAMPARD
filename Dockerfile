# Etapa 1: Construcción
FROM node:20-alpine AS build

WORKDIR /app

# Habilitar corepack para usar pnpm de forma nativa
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copiar archivos de dependencias
COPY package.json pnpm-lock.yaml ./

# Instalar dependencias con congelación de versión
RUN pnpm install --frozen-lockfile

# Copiar el resto del código fuente
COPY . .

# Compilar la aplicación web
RUN pnpm run build

# Etapa 2: Servidor Web de Producción
FROM nginx:alpine

# Copiar la compilación estática al directorio de nginx
COPY --from=build /app/dist /usr/share/nginx/html

# Exponer el puerto estándar HTTP
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
